/**
 * MiniMax provider (OpenAI-compatible Chat Completions API).
 *
 * MiniMax's LLM API (`https://api.minimax.io/v1/chat/completions`) follows
 * the OpenAI wire format, so this provider uses plain `fetch` — no SDK — and
 * implements the same `AIProvider` contract as GroqProvider / NvidiaProvider.
 *
 * The API key is sent as `Authorization: Bearer <key>` (server-side only —
 * the CLI never holds or sends `MINIMAX_API_KEY`).
 *
 * Model: MiniMax-M3 (1M context, tool calling, adaptive thinking). The model
 * id is centralized in src/agents/modelRouter.ts; `reasoning_split: true`
 * keeps thinking blocks out of `content` so tool-call parsing stays clean.
 *
 * Capabilities wired in: chat completion, tool/function calling, usage
 * reporting including cached input tokens (`prompt_tokens_details.cached_tokens`),
 * max output control, cancellation (AbortSignal) and classified, scrubbed
 * `ProviderError`s. Streaming is buffered through `chat` like the other
 * server-side providers (the backend proxy is non-streaming).
 */
import { scrub, ProviderError } from './errors.ts';
import type { AIProvider, ChatMessage, ChatOptions, ChatResult, ModelInfo, StreamEvent, ToolCallParam, ToolDefinition, Usage } from './types.ts';

export const MINIMAX_BASE_URL = 'https://api.minimax.io/v1';

/** Fallback default only — the real default lives in the model router. */
export const DEFAULT_MINIMAX_MODEL = 'MiniMax-M3';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONTEXT = 1_000_000;

interface MiniMaxResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: MiniMaxToolCall[] };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string; type?: string; code?: string };
  /** MiniMax business-level status; non-zero means an error even on HTTP 200. */
  base_resp?: { status_code?: number; status_msg?: string };
}

interface MiniMaxToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** Convert our messages to the OpenAI/MiniMax wire format. */
function toWire(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.tool_call_id ?? '', content: m.content ?? '' };
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: 'assistant',
        content: m.content ?? null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

function toUsage(u: MiniMaxResponse['usage']): Usage | undefined {
  if (!u) return undefined;
  const inputTokens = u.prompt_tokens ?? 0;
  const outputTokens = u.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: u.total_tokens ?? inputTokens + outputTokens,
    cachedInputTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

/** Cached input tokens (MiniMax reports prompt_tokens_details.cached_tokens). */
export function cachedInputTokens(u: MiniMaxResponse['usage']): number {
  return u?.prompt_tokens_details?.cached_tokens ?? 0;
}

/** Classify a failed MiniMax response (HTTP status + body) into a category. */
function classifyFailure(status: number, data: MiniMaxResponse | null): ProviderError['category'] {
  const msg = data?.error?.message ?? data?.base_resp?.status_msg ?? '';
  const code = data?.base_resp?.status_code ?? 0;
  const isQuota = /quota|exhausted|balance|insufficient/i.test(msg);
  const isRate = /rate.?limit|too many|frequency/i.test(msg);
  if (status === 401 || status === 403 || code === 1004) return 'authentication';
  if (status === 429 || isRate) return isQuota ? 'quota_exhausted' : 'rate_limit';
  if (status === 404) return 'unavailable_model';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server_error';
  if (isQuota) return 'quota_exhausted';
  return 'unknown';
}

export class MiniMaxProvider implements AIProvider {
  readonly id = 'minimax';
  readonly label = 'MiniMax';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private modelId: string;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string; timeoutMs?: number }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? MINIMAX_BASE_URL).replace(/\/+$/, '');
    this.modelId = opts.model ?? DEFAULT_MINIMAX_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  getModel(): ModelInfo {
    return {
      id: this.modelId,
      contextWindow: DEFAULT_CONTEXT,
      supportedFeatures: ['tool_calls', 'json', 'streaming'],
    };
  }

  setModel(modelId: string): void {
    this.modelId = modelId;
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10_000)),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      return (data.data ?? []).map((m) => m.id).sort();
    } catch {
      return [];
    }
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: toWire(messages),
      temperature: options.temperature ?? 0.2,
      // reasoning_split keeps <think> blocks out of content (tool-call safe).
      reasoning_split: true,
    };
    // MiniMax recommends max_completion_tokens (max_tokens is deprecated).
    if (options.maxTokens !== undefined) body.max_completion_tokens = options.maxTokens;
    if (options.tools && options.tools.length > 0) body.tools = options.tools.map((t) => t as unknown as Record<string, unknown>);

    const data = await this.post(body, options);
    const choice = data.choices?.[0];
    if (!choice) {
      throw new ProviderError(this.id, 'malformed_response', 'MiniMax returned no completion choices.', 200);
    }
    const msg = choice.message;
    return {
      content: msg?.content ?? null,
      toolCalls: msg?.tool_calls ? fromWireToolCalls(msg.tool_calls) : [],
      usage: toUsage(data.usage),
      finishReason: choice.finish_reason ?? 'stop',
    };
  }

  /** Buffered stream: the backend proxy is non-streaming (single JSON). */
  async *streamChat(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<StreamEvent> {
    const result = await this.chat(messages, options);
    if (result.content) yield { type: 'content', content: result.content };
    for (const [index, tc] of result.toolCalls.entries()) {
      yield { type: 'tool_call_delta', index, id: tc.id, name: tc.name, argumentsDelta: tc.arguments };
    }
    yield { type: 'done', usage: result.usage };
  }

  private async post(body: Record<string, unknown>, options: ChatOptions): Promise<MiniMaxResponse> {
    const signals: AbortSignal[] = [];
    if (options.signal) signals.push(options.signal);
    signals.push(AbortSignal.timeout(this.timeoutMs));

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      if (isTimeout) throw new ProviderError(this.id, 'timeout', 'MiniMax request timed out.');
      throw new ProviderError(this.id, 'network', 'Could not reach the MiniMax API.');
    }

    let data: MiniMaxResponse | null = null;
    try {
      data = JSON.parse(await res.text()) as MiniMaxResponse;
    } catch {
      data = null;
    }

    if (!res.ok) {
      const detail = scrub(data?.error?.message ?? '');
      throw new ProviderError(this.id, classifyFailure(res.status, data), detail || 'MiniMax request failed.', res.status);
    }
    if (!data) {
      throw new ProviderError(this.id, 'malformed_response', 'MiniMax returned an unparseable response.', res.status);
    }
    // MiniMax can return HTTP 200 with a business-level error (base_resp).
    const code = data.base_resp?.status_code ?? 0;
    if (code !== 0) {
      const detail = scrub(data.base_resp?.status_msg ?? `MiniMax error ${code}`);
      throw new ProviderError(this.id, classifyFailure(200, data), detail, 200);
    }
    return data;
  }
}

function fromWireToolCalls(tcs: MiniMaxToolCall[]): ToolCallParam[] {
  return tcs.map((tc) => ({
    id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
    name: tc.function?.name ?? 'unknown',
    arguments: tc.function?.arguments ?? '{}',
  }));
}
