/**
 * Client-side remote provider (Milestone 11 wiring).
 *
 * When the CLI has no local GROQ_API_KEY but the user is logged in, agent runs
 * are proxied to the ZEESH AI backend (`POST /api/provider`), where the
 * production provider key lives — it never reaches the CLI. This provider
 * implements the same `AIProvider` contract as the local Groq provider, so
 * AgentLoop and the CLI are unchanged.
 *
 * The backend proxy is non-streaming today: `streamChat` buffers the single
 * response and replays it as stream events.
 */
import type { DailySessionState } from '../auth/client.ts';
import type {
  AIProvider,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ModelInfo,
  StreamEvent,
  ToolCallParam,
  Usage,
} from './types.ts';

export interface RemoteProviderOptions {
  /** Backend base URL (e.g. https://zeesh-ai.vercel.app). */
  apiUrl: string;
  /** Session token sent as `Authorization: Bearer <token>`. */
  token: string;
  model?: string;
  /** Per-request timeout. Model calls take longer than auth/usage calls. */
  timeoutMs?: number;
}

/** An error from the ZEESH AI backend (status 0 = unreachable/timeout). */
export class RemoteProviderError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CONTEXT = 131_072;

/** Response shape of POST /api/provider (see src/api/handlers.ts providerHandler). */
interface ProviderResponse {
  content: string | null;
  tool_calls?: ToolCallParam[];
  usage?: Usage;
  finish_reason?: string;
  /** ZEESH FREE session state; `startedNew` is set when this request rolled the user into a fresh session. */
  session?: DailySessionState & { startedNew?: boolean };
}

/** Free-plan state from the last provider response (success or 429; or null). */
export type LastSessionInfo = DailySessionState & { startedNew?: boolean };

export class RemoteProvider implements AIProvider {
  readonly id = 'remote';
  readonly label = 'ZEESH AI backend';

  private readonly apiUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private modelId: string;
  private sessionInfo: LastSessionInfo | null = null;

  constructor(opts: RemoteProviderOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.modelId = opts.model ?? 'openai/gpt-oss-120b';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Free-plan state from the most recent provider response (ZEESH FREE).
   * Null until the first response that carries session state, or when the
   * backend predates the session system.
   */
  get lastSession(): LastSessionInfo | null {
    return this.sessionInfo;
  }

  getModel(): ModelInfo {
    return {
      id: this.modelId,
      contextWindow: DEFAULT_CONTEXT,
      supportedFeatures: ['tool_calls', 'json'],
    };
  }

  setModel(modelId: string): void {
    this.modelId = modelId;
  }

  /** Model discovery stays server-side; the backend selects from its own list. */
  async listModels(): Promise<string[]> {
    return [];
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const data = await this.post(messages, options);
    if (data?.session) this.sessionInfo = data.session;
    return {
      content: data?.content ?? null,
      toolCalls: data?.tool_calls ?? [],
      usage: data?.usage,
      finishReason: data?.finish_reason ?? 'stop',
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

  private async post(messages: ChatMessage[], options: ChatOptions): Promise<ProviderResponse | null> {
    const body: Record<string, unknown> = {
      messages,
      model: this.modelId,
      temperature: options.temperature ?? 0.2,
    };
    if (options.maxTokens !== undefined) body.maxTokens = options.maxTokens;
    if (options.tools && options.tools.length > 0) body.tools = options.tools;

    let res: Response;
    try {
      const signals: AbortSignal[] = [];
      if (options.signal) signals.push(options.signal);
      signals.push(AbortSignal.timeout(this.timeoutMs));
      res = await fetch(`${this.apiUrl}/api/provider`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      const detail = isTimeout ? 'The request timed out.' : `Could not reach ${this.apiUrl}.`;
      throw new RemoteProviderError(0, `${detail} Check your connection and ZEESH_API_URL.`);
    }

    const data = (await res.json().catch(() => null)) as (ProviderResponse & { error?: string; code?: string }) | null;
    if (!res.ok) {
      // Even a rejection (e.g. 429 daily_limit_exhausted) may carry the current
      // session state, so the CLI can still render the quota.
      if (res.status === 429 && data?.session) this.sessionInfo = data.session;
      throw new RemoteProviderError(res.status, this.describeError(res.status, data?.error, data?.code));
    }
    if (data === null) {
      throw new RemoteProviderError(res.status, 'The ZEESH AI backend returned an invalid response.');
    }
    return data;
  }

  private describeError(status: number, error?: string, code?: string): string {
    if (status === 401) {
      return 'Your ZEESH AI session is invalid or expired — run "zeesh login" again.';
    }
    if (status === 429) {
      if (code === 'daily_limit_exhausted') {
        // The server's message is the authoritative, user-safe text.
        return error ?? 'You have used all free sessions for today.';
      }
      return 'The ZEESH AI backend rate limit was hit — wait a moment and retry.';
    }
    return error ? `${error} (status ${status})` : `The ZEESH AI backend returned status ${status}.`;
  }
}
