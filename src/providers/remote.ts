/**
 * Client-side remote provider (Milestone 11 wiring).
 *
 * When the CLI has no local GROQ_API_KEY but the user is logged in, agent runs
 * are proxied to the GRACE backend (`POST /api/provider`), where the
 * production provider key lives — it never reaches the CLI. This provider
 * implements the same `AIProvider` contract as the local Groq provider, so
 * AgentLoop and the CLI are unchanged.
 *
 * The backend proxy is non-streaming today: `streamChat` buffers the single
 * response and replays it as stream events.
 */
import type { DailySessionState } from '../auth/client.ts';
import type { ModelTier } from '../agents/types.ts';
import { DEFAULT_NVIDIA_MODEL } from './nvidia.ts';
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
  /** Model tier hint sent with each request (role routing; server-authoritative). */
  tier?: ModelTier;
  /** Per-request timeout. Model calls take longer than auth/usage calls. */
  timeoutMs?: number;
}

/** An error from the GRACE backend (status 0 = unreachable/timeout). */
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
  /** Provider that actually served the request (after server-side router fallback). */
  provider_id?: string;
  provider_label?: string;
  /** GRACE FREE session state; `startedNew` is set when this request rolled the user into a fresh session. */
  session?: DailySessionState & { startedNew?: boolean };
}

/** Free-plan state from the last provider response (success or 429; or null). */
export type LastSessionInfo = DailySessionState & { startedNew?: boolean };

/**
 * Module-level shared view of the freshest server state. Role routing creates
 * several RemoteProvider instances per run (one per agent tier) against the
 * same backend, so the most recent response's session/provider facts are made
 * visible to the CLI regardless of which instance received it. Per-instance
 * getters (lastSession/serverProvider) stay instance-scoped for tests.
 */
interface SharedRemoteState {
  session: LastSessionInfo | null;
  serverProvider: { id: string; label: string } | null;
}

const sharedState: SharedRemoteState = { session: null, serverProvider: null };

/** Clear the shared state (test hook; also resets at process start). */
export function resetSharedRemoteState(): void {
  sharedState.session = null;
  sharedState.serverProvider = null;
}

export class RemoteProvider implements AIProvider {
  readonly id = 'remote';
  readonly label = 'GRACE backend';

  private readonly apiUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly tier: ModelTier | undefined;
  private modelId: string;
  private sessionInfo: LastSessionInfo | null = null;
  private serverProviderInfo: { id: string; label: string } | null = null;

  constructor(opts: RemoteProviderOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '');
    this.token = opts.token;
    // NVIDIA-first default; the server verifies it against its live catalog.
    this.modelId = opts.model ?? DEFAULT_NVIDIA_MODEL;
    this.tier = opts.tier;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** The model tier this instance sends with its requests (role routing). */
  get modelTier(): ModelTier | undefined {
    return this.tier;
  }

  /**
   * A copy of this provider pinned to a different model + tier — used by the
   * role router so each agent tier gets its own route over the same backend.
   */
  withModel(model: string, tier?: ModelTier): RemoteProvider {
    return new RemoteProvider({ apiUrl: this.apiUrl, token: this.token, model, tier, timeoutMs: this.timeoutMs });
  }

  /**
   * Free-plan state from the most recent provider response (GRACE FREE).
   * Null until the first response that carries session state, or when the
   * backend predates the session system.
   */
  get lastSession(): LastSessionInfo | null {
    return this.sessionInfo;
  }

  /**
   * Freshest session state across ALL RemoteProvider instances (role routing
   * creates several per run) — what the CLI renders after a task. Null until
   * any instance saw session state.
   */
  static sharedSession(): LastSessionInfo | null {
    return sharedState.session;
  }

  /** Freshest serving-provider report across all instances (see sharedSession). */
  static sharedServerProvider(): { id: string; label: string } | null {
    return sharedState.serverProvider;
  }

  /**
   * Provider the backend router actually served (e.g. NVIDIA NIM), reported by
   * the server after the first successful request. Null for local providers or
   * backends that predate provider reporting — /model then shows the transport.
   */
  get serverProvider(): { id: string; label: string } | null {
    return this.serverProviderInfo;
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
    if (data?.session) {
      this.sessionInfo = data.session;
      sharedState.session = data.session;
    }
    if (data?.provider_id) {
      const info = { id: data.provider_id, label: data.provider_label ?? data.provider_id };
      this.serverProviderInfo = info;
      sharedState.serverProvider = info;
    }
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
    if (this.tier) body.tier = this.tier;
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
      if (res.status === 429 && data?.session) {
        this.sessionInfo = data.session;
        sharedState.session = data.session;
      }
      throw new RemoteProviderError(res.status, this.describeError(res.status, data?.error, data?.code));
    }
    if (data === null) {
      throw new RemoteProviderError(res.status, 'The GRACE backend returned an invalid response.');
    }
    return data;
  }

  private describeError(status: number, error?: string, code?: string): string {
    if (status === 401) {
      return 'Your GRACE session is invalid or expired — run "grace login" again.';
    }
    if (status === 429) {
      if (code === 'daily_limit_exhausted' || code === 'daily_cost_exhausted' || code === 'global_cost_exhausted') {
        // The server's message is the authoritative, user-safe text (it never
        // reveals spending, tokens or provider economics).
        return error ?? 'Grace has reached today\'s usage capacity. Please try again after the daily reset.';
      }
      return 'The GRACE backend rate limit was hit — wait a moment and retry.';
    }
    return error ? `${error} (status ${status})` : `The GRACE backend returned status ${status}.`;
  }
}
