/**
 * DeepSeek provider (OpenAI-compatible hosted API).
 *
 * DeepSeek's API (`https://api.deepseek.com`) follows the OpenAI
 * chat-completions wire format, so this provider uses plain `fetch` — no
 * extra SDK dependency — and implements the same `AIProvider` contract as
 * GroqProvider / NvidiaProvider. The agent loop, coordinator and CLI are
 * completely unchanged: adding DeepSeek is purely a provider-registry + env
 * change, never an agent-architecture change.
 *
 * Primary models:
 *   - deepseek-chat     the general chat model (coding tier),
 *   - deepseek-reasoner the reasoning model (reasoning tier).
 *
 * Intended for SERVER-SIDE use (src/api/providers.ts) so `DEEPSEEK_API_KEY`
 * never reaches the CLI. All failures are thrown as classified, scrubbed
 * `ProviderError`s so the router can fall back safely.
 */
import { scrub, ProviderError } from './errors.ts';
import type { AIProvider, ChatMessage, ChatOptions, ChatResult, ModelInfo, StreamEvent, ToolCallParam, Usage } from './types.ts';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONTEXT = 64_000;

/** Context windows for models we ship defaults for (documented DeepSeek models). */
const KNOWN_CONTEXTS: Record<string, number> = {
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,
};

/** OpenAI-compatible chat completion response (the fields we consume). */
interface DeepSeekChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: DeepSeekToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_cache_hit_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

interface DeepSeekToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** Convert our messages to the OpenAI chat-completions wire format. */
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

function toUsage(u: DeepSeekChatResponse['usage']): Usage | undefined {
  if (!u) return undefined;
  const inputTokens = u.prompt_tokens ?? 0;
  const outputTokens = u.completion_tokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: u.total_tokens ?? inputTokens + outputTokens };
}

/** Classify a failed HTTP response (status + parsed body) into a category. */
function classifyFailure(status: number, data: DeepSeekChatResponse | null): ProviderError['category'] {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  if (status === 408) return 'timeout';
  const msg = data?.error?.message ?? '';
  if (status === 404 || /model[^.]*(not found|does not exist|unavailable)|not.*support/i.test(msg)) {
    return 'unavailable_model';
  }
  if (status >= 500) return 'unavailable_model';
  return 'unknown';
}

export class DeepSeekProvider implements AIProvider {
  readonly id = 'deepseek';
  readonly label = 'DeepSeek';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private modelId: string;
  private modelsCache: string[] | null = null;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string; timeoutMs?: number }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, '');
    this.modelId = opts.model ?? DEFAULT_DEEPSEEK_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  getModel(): ModelInfo {
    return {
      id: this.modelId,
      contextWindow: KNOWN_CONTEXTS[this.modelId] ?? DEFAULT_CONTEXT,
      supportedFeatures: ['tool_calls', 'json'],
    };
  }

  setModel(modelId: string): void {
    this.modelId = modelId;
    this.modelsCache = null;
  }

  async listModels(): Promise<string[]> {
    if (this.modelsCache) return this.modelsCache;
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10_000)),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      this.modelsCache = (data.data ?? []).map((m) => m.id).sort();
      return this.modelsCache;
    } catch {
      return [];
    }
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: toWire(messages),
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 4096,
    };
    if (options.tools && options.tools.length > 0) body.tools = options.tools;

    const data = await this.post(body, options);
    const choice = data.choices?.[0];
    if (!choice) {
      throw new ProviderError(this.id, 'malformed_response', 'DeepSeek returned no completion choices.', 200);
    }
    const msg = choice.message;
    return {
      content: msg?.content ?? null,
      toolCalls: msg?.tool_calls ? fromWireToolCalls(msg.tool_calls) : [],
      usage: toUsage(data.usage),
      finishReason: choice.finish_reason ?? 'stop',
    };
  }

  /** Buffered stream: DeepSeek is used server-side where the proxy is non-streaming. */
  async *streamChat(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<StreamEvent> {
    const result = await this.chat(messages, options);
    if (result.content) yield { type: 'content', content: result.content };
    for (const [index, tc] of result.toolCalls.entries()) {
      yield { type: 'tool_call_delta', index, id: tc.id, name: tc.name, argumentsDelta: tc.arguments };
    }
    yield { type: 'done', usage: result.usage };
  }

  private async post(body: Record<string, unknown>, options: ChatOptions): Promise<DeepSeekChatResponse> {
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
      if (isTimeout) throw new ProviderError(this.id, 'timeout', 'DeepSeek request timed out.');
      throw new ProviderError(this.id, 'network', 'Could not reach DeepSeek.');
    }

    let data: DeepSeekChatResponse | null = null;
    try {
      data = JSON.parse(await res.text()) as DeepSeekChatResponse;
    } catch {
      data = null;
    }

    if (!res.ok) {
      const detail = scrub(data?.error?.message ?? '');
      throw new ProviderError(this.id, classifyFailure(res.status, data), detail || 'DeepSeek request failed.', res.status);
    }
    if (!data) {
      throw new ProviderError(this.id, 'malformed_response', 'DeepSeek returned an unparseable response.', res.status);
    }
    return data;
  }
}

function fromWireToolCalls(tcs: DeepSeekToolCall[]): ToolCallParam[] {
  return tcs.map((tc) => ({
    id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
    name: tc.function?.name ?? 'unknown',
    arguments: tc.function?.arguments ?? '{}',
  }));
}
