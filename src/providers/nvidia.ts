/**
 * NVIDIA NIM provider (OpenAI-compatible hosted API).
 *
 * Talks to NVIDIA's hosted NIM catalog (`https://integrate.api.nvidia.com/v1`)
 * through the OpenAI chat-completions wire format, using only `fetch` — no
 * extra SDK dependency. Implements the same `AIProvider` contract as
 * GroqProvider, so the agent loop, coordinator and CLI are unchanged.
 *
 * Used SERVER-SIDE ONLY (src/api/providers.ts): the CLI never holds or sends
 * `NVIDIA_API_KEY`, so the key stays on the server. All failures are thrown
 * as classified `ProviderError`s with scrubbed, key-free messages so the
 * server can fall back safely and surface a clear error.
 */
import { scrub, ProviderError } from './errors.ts';
import type { AIProvider, ChatMessage, ChatOptions, ChatResult, ModelInfo, StreamEvent, ToolCallParam, Usage } from './types.ts';

export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

/**
 * Default model: one NVIDIA-hosted, coding-capable model (build.nvidia.com
 * catalog). GPT-OSS 20B is a strong code model with native OpenAI-style
 * function calling (which the agent loop relies on) and fast inference.
 *
 * NOTE: the older defaults (`qwen/qwen2.5-coder-32b-instruct`,
 * `deepseek-ai/deepseek-r1`) reached end-of-life on NVIDIA and now return
 * HTTP 410, which is why they were replaced. Set `NVIDIA_MODEL` to override.
 */
export const DEFAULT_NVIDIA_MODEL = 'openai/gpt-oss-20b';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONTEXT = 131_072;

/** Context windows for models we ship defaults for (documented NVIDIA NIM models). */
const KNOWN_CONTEXTS: Record<string, number> = {
  'openai/gpt-oss-20b': 131_072,
  'openai/gpt-oss-120b': 131_072,
  'nvidia/llama-3.3-nemotron-super-49b-v1.5': 131_072,
  'z-ai/glm-5.2': 131_072,
};

/** OpenAI-compatible chat completion response (the fields we consume). */
interface NvidiaChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: NvidiaToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
  // NVIDIA problem-details shape (used for model rejection, e.g. 410 Gone).
  title?: string;
  detail?: string;
}

interface NvidiaToolCall {
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

function toUsage(u: NvidiaChatResponse['usage']): Usage | undefined {
  if (!u) return undefined;
  const inputTokens = u.prompt_tokens ?? 0;
  const outputTokens = u.completion_tokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: u.total_tokens ?? inputTokens + outputTokens };
}

/**
 * Classify a failed HTTP response (status + parsed body) into a category.
 *
 * NVIDIA returns two error shapes: OpenAI-style `{ error: { message } }` and
 * problem-details `{ type, title, status, detail }` (used for 4xx rejections
 * such as 404/410 model-not-found). Both are handled here.
 */
function classifyFailure(status: number, data: NvidiaChatResponse | null): ProviderError['category'] {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  if (status === 408) return 'timeout';
  const msg = data?.error?.message ?? data?.title ?? '';
  // 410 Gone = model decommissioned / reached end of life → treat as unavailable.
  if (status === 404 || status === 410) return 'unavailable_model';
  if (/model[^.]*(not found|does not exist|unavailable|end of life)|not.*support/i.test(msg)) {
    return 'unavailable_model';
  }
  if (status >= 500) return 'unavailable_model'; // provider-side outage → fallback
  return 'unknown';
}

export class NvidiaProvider implements AIProvider {
  readonly id = 'nvidia';
  readonly label = 'NVIDIA NIM';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private modelId: string;
  private modelsCache: string[] | null = null;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string; timeoutMs?: number }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? NVIDIA_BASE_URL).replace(/\/+$/, '');
    this.modelId = opts.model ?? DEFAULT_NVIDIA_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  getModel(): ModelInfo {
    return {
      id: this.modelId,
      contextWindow: KNOWN_CONTEXTS[this.modelId] ?? DEFAULT_CONTEXT,
      supportedFeatures: ['tool_calls', 'streaming', 'json'],
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
      throw new ProviderError(this.id, 'malformed_response', 'NVIDIA NIM returned no completion choices.', 200);
    }
    const msg = choice.message;
    return {
      content: msg?.content ?? null,
      toolCalls: msg?.tool_calls ? fromWireToolCalls(msg.tool_calls) : [],
      usage: toUsage(data.usage),
      finishReason: choice.finish_reason ?? 'stop',
    };
  }

  /** Buffered stream: NVIDIA is used server-side where the proxy is non-streaming. */
  async *streamChat(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<StreamEvent> {
    const result = await this.chat(messages, options);
    if (result.content) yield { type: 'content', content: result.content };
    for (const [index, tc] of result.toolCalls.entries()) {
      yield { type: 'tool_call_delta', index, id: tc.id, name: tc.name, argumentsDelta: tc.arguments };
    }
    yield { type: 'done', usage: result.usage };
  }

  private async post(body: Record<string, unknown>, options: ChatOptions): Promise<NvidiaChatResponse> {
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
      if (isTimeout) throw new ProviderError(this.id, 'timeout', 'NVIDIA NIM request timed out.');
      // Fetch throws TypeError on DNS/TLS/connection failures.
      throw new ProviderError(this.id, 'network', 'Could not reach NVIDIA NIM.');
    }

    let data: NvidiaChatResponse | null = null;
    try {
      data = JSON.parse(await res.text()) as NvidiaChatResponse;
    } catch {
      data = null;
    }

    if (!res.ok) {
      // Scrub provider text: it must never carry a key (defense in depth —
      // even a misbehaving provider cannot leak credentials downstream).
      // Handle both OpenAI-style errors and NVIDIA problem-details payloads.
      const raw = data?.error?.message ?? data?.detail ?? data?.title ?? '';
      const detail = scrub(String(raw));
      throw new ProviderError(this.id, classifyFailure(res.status, data), detail || 'NVIDIA NIM request failed.', res.status);
    }
    if (!data) {
      throw new ProviderError(this.id, 'malformed_response', 'NVIDIA NIM returned an unparseable response.', res.status);
    }
    return data;
  }
}

function fromWireToolCalls(tcs: NvidiaToolCall[]): ToolCallParam[] {
  return tcs.map((tc) => ({
    id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
    name: tc.function?.name ?? 'unknown',
    arguments: tc.function?.arguments ?? '{}',
  }));
}
