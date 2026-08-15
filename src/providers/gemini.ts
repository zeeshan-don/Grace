/**
 * Gemini provider (Google Generative Language API).
 *
 * Talks to the Gemini REST API (`generativelanguage.googleapis.com/v1beta`)
 * with plain `fetch` — no SDK dependency — and implements the same
 * `AIProvider` contract as GroqProvider / NvidiaProvider, so the agent loop,
 * coordinator and CLI are unchanged.
 *
 * The API key is passed via the `x-goog-api-key` header (never a URL query
 * param, so it cannot leak into access logs). Used SERVER-SIDE ONLY
 * (src/api/providers.ts): the CLI never holds or sends `GEMINI_API_KEY`.
 *
 * Capabilities wired in: chat completion, tool/function calling (with
 * functionCall → functionResponse turns), usage reporting (input/output/
 * cached tokens from `usageMetadata`), max output control, cancellation
 * (AbortSignal) and classified, scrubbed `ProviderError`s so the router can
 * fall back safely. Streaming is buffered through `chat` (like NVIDIA and
 * DeepSeek) — the backend proxy is non-streaming.
 *
 * Default model: gemini-3.1-flash-lite (stable as of May 2026). The model id
 * is centralized in src/agents/modelRouter.ts — nothing here hardcodes it
 * beyond the DEFAULT fallback used when no model is passed in.
 */
import { scrub, ProviderError } from './errors.ts';
import type { AIProvider, ChatMessage, ChatOptions, ChatResult, ModelInfo, StreamEvent, ToolCallParam, ToolDefinition, Usage } from './types.ts';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** Fallback default only — the real default lives in the model router. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONTEXT = 1_048_576;

/** Known context windows for models we ship defaults for. */
const KNOWN_CONTEXTS: Record<string, number> = {
  'gemini-3.1-flash-lite': 1_048_576,
  'gemini-3.1-flash-lite-preview': 1_048_576,
  'gemini-2.5-flash-lite': 1_048_576,
};

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  error?: { code?: number; status?: string; message?: string };
}

/** Convert our messages to Gemini's contents + systemInstruction. */
function toGemini(messages: ChatMessage[]): { system: string; contents: GeminiContent[] } {
  const systems: string[] = [];
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systems.push(m.content);
      continue;
    }
    const parts: GeminiPart[] = [];
    if (m.role === 'assistant') {
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls ?? []) {
        parts.push({ functionCall: { name: tc.name, args: parseArgs(tc.arguments) } });
      }
      const content: GeminiContent = { role: 'model', parts };
      if (parts.length > 0) contents.push(content);
      continue;
    }
    if (m.role === 'tool') {
      const name = m.name ?? 'tool';
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name, response: toolResultToStruct(m.content ?? '') } }],
      });
      continue;
    }
    // user
    if (m.content) contents.push({ role: 'user', parts: [{ text: m.content }] });
  }
  return { system: systems.join('\n\n'), contents: mergeConsecutive(contents) };
}

/** Gemini requires functionCall args as a JSON object — parse, else {}. */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** functionResponse.response must be a struct — parse tool text, else wrap it. */
function toolResultToStruct(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return { result: content };
}

/** Merge consecutive same-role messages (Gemini is picky about alternation). */
function mergeConsecutive(contents: GeminiContent[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const c of contents) {
    const last = out[out.length - 1];
    if (last && last.role === c.role) {
      last.parts = [...last.parts, ...c.parts];
    } else {
      out.push({ role: c.role, parts: [...c.parts] });
    }
  }
  return out;
}

function toUsage(u: GeminiResponse['usageMetadata']): Usage | undefined {
  if (!u) return undefined;
  const inputTokens = u.promptTokenCount ?? 0;
  const outputTokens = u.candidatesTokenCount ?? 0;
  const cached = u.cachedContentTokenCount ?? 0;
  return { inputTokens, outputTokens, totalTokens: u.totalTokenCount ?? inputTokens + outputTokens, cachedInputTokens: cached };
}

/** Cached input tokens (Gemini reports cachedContentTokenCount). */
export function cachedInputTokens(u: GeminiResponse['usageMetadata']): number {
  return u?.cachedContentTokenCount ?? 0;
}

/** Classify a failed Gemini response (status + error body) into a category. */
function classifyFailure(status: number, data: GeminiResponse | null): ProviderError['category'] {
  const err = data?.error;
  const msg = err?.message ?? '';
  const isQuota = err?.status === 'RESOURCE_EXHAUSTED' || /quota|exhausted|limit/i.test(msg);
  if (status === 401 || status === 403) {
    return isQuota ? 'quota_exhausted' : 'authentication';
  }
  if (status === 429) return isQuota ? 'quota_exhausted' : 'rate_limit';
  if (status === 404) return 'unavailable_model';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server_error';
  return isQuota ? 'quota_exhausted' : 'unknown';
}

export class GeminiProvider implements AIProvider {
  readonly id = 'gemini';
  readonly label = 'Gemini';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private modelId: string;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string; timeoutMs?: number }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, '');
    this.modelId = opts.model ?? DEFAULT_GEMINI_MODEL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  getModel(): ModelInfo {
    return {
      id: this.modelId,
      contextWindow: KNOWN_CONTEXTS[this.modelId] ?? DEFAULT_CONTEXT,
      supportedFeatures: ['tool_calls', 'json', 'streaming'],
    };
  }

  setModel(modelId: string): void {
    this.modelId = modelId;
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models?pageSize=1000`, {
        headers: { 'x-goog-api-key': this.apiKey },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10_000)),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      return (data.models ?? [])
        .map((m) => m.name.replace(/^models\//, ''))
        .filter((id) => id.includes('gemini'))
        .sort();
    } catch {
      return [];
    }
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const { system, contents } = toGemini(messages);
    const body: Record<string, unknown> = { contents };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const tools = options.tools;
    if (tools && tools.length > 0) {
      body.tools = [{ functionDeclarations: tools.map((t) => toFunctionDeclaration(t)) }];
    }
    const generationConfig: Record<string, unknown> = {};
    if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
    if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;

    const data = await this.post(body, options);
    const candidate = data.candidates?.[0];
    if (!candidate || !candidate.content) {
      throw new ProviderError(this.id, 'malformed_response', 'Gemini returned no completion candidates.', 200);
    }
    const toolCalls: ToolCallParam[] = [];
    let text = '';
    for (const [index, part] of (candidate.content.parts ?? []).entries()) {
      if (part.text !== undefined) text += part.text;
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${index}`,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        });
      }
    }
    return {
      content: text || null,
      toolCalls,
      usage: toUsage(data.usageMetadata),
      finishReason: mapFinishReason(candidate.finishReason),
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

  private async post(body: Record<string, unknown>, options: ChatOptions): Promise<GeminiResponse> {
    const signals: AbortSignal[] = [];
    if (options.signal) signals.push(options.signal);
    signals.push(AbortSignal.timeout(this.timeoutMs));

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/models/${this.modelId}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      if (isTimeout) throw new ProviderError(this.id, 'timeout', 'Gemini request timed out.');
      throw new ProviderError(this.id, 'network', 'Could not reach the Gemini API.');
    }

    let data: GeminiResponse | null = null;
    try {
      data = JSON.parse(await res.text()) as GeminiResponse;
    } catch {
      data = null;
    }

    if (!res.ok) {
      const detail = scrub(data?.error?.message ?? '');
      throw new ProviderError(this.id, classifyFailure(res.status, data), detail || 'Gemini request failed.', res.status);
    }
    if (!data) {
      throw new ProviderError(this.id, 'malformed_response', 'Gemini returned an unparseable response.', res.status);
    }
    return data;
  }
}

function toFunctionDeclaration(t: ToolDefinition): Record<string, unknown> {
  return { name: t.function.name, description: t.function.description, parameters: t.function.parameters };
}

function mapFinishReason(reason: string | undefined): string {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
      return 'content_filter';
    case 'RECITATION':
      return 'recitation';
    default:
      return reason?.toLowerCase() ?? 'stop';
  }
}
