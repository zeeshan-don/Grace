/**
 * HTTP client for the ZEESH AI backend (Milestone 11).
 *
 * The CLI talks to the backend only through this client. It never touches
 * GROQ_API_KEY, DATABASE_URL or any other server secret — the only credential
 * it sends is the user's own session token.
 *
 * Every call has a timeout and maps transport/HTTP failures to `ApiError`, so
 * callers (e.g. the usage reporter) can degrade gracefully when the backend
 * is offline.
 */

/** An HTTP or transport error from the backend. status 0 = unreachable/timeout. */
export class ApiError extends Error {
  readonly status: number;
  /** Seconds to wait before retrying (only set for 429 rate-limit responses). */
  readonly retryAfterSeconds?: number;

  constructor(status: number, message: string, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ApiUser {
  id: string;
  email: string;
  display_name: string | null;
}

/** Result of login/register: the account plus a fresh session token. */
export interface SessionResult {
  user: ApiUser;
  token: string;
  expires_at: string;
}

/** Payload for POST /api/usage (mirrors src/api/usage.ts UsageReport). */
export interface UsageReportPayload {
  client_run_id: string;
  user_id: string;
  session_id?: string;
  project_type?: string;
  prompt?: string;
  status: 'running' | 'done' | 'error' | 'denied';
  model: string;
  agent_turns: number;
  tool_calls?: number;
  input_tokens: number;
  output_tokens: number;
  execution_time_ms?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;

export class ApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  /** Create an account and return a session token. */
  async register(email: string, password: string, displayName?: string): Promise<SessionResult> {
    return this.request<SessionResult>('/api/auth/register', {
      method: 'POST',
      body: { email, password, display_name: displayName ?? null },
    });
  }

  /** Verify credentials and return a session token. */
  async login(email: string, password: string): Promise<SessionResult> {
    return this.request<SessionResult>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
  }

  /** Invalidate a session server-side. */
  async logout(token: string): Promise<void> {
    await this.request<{ logged_out: boolean }>('/api/auth/logout', { method: 'POST', token });
  }

  /** Resolve the current user for a session token (whoami). */
  async me(token: string): Promise<ApiUser> {
    const data = await this.request<{ user: ApiUser }>('/api/auth/me', { method: 'GET', token });
    return data.user;
  }

  /** Record one agent run + token usage. */
  async reportUsage(token: string, report: UsageReportPayload): Promise<{ run_id?: number }> {
    return this.request<{ run_id?: number }>('/api/usage', { method: 'POST', token, body: report });
  }

  private async request<T>(
    path: string,
    init: { method: string; token?: string; body?: unknown },
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method: init.method,
        headers: {
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      const detail = isTimeout ? 'The request timed out.' : `Could not reach ${this.baseUrl}.`;
      throw new ApiError(0, `${detail} Is the backend running? (npm run serve). Check ZEESH_API_URL if you changed it.`);
    }

    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
      // Carry the Retry-After hint for 429 rate-limit responses so the CLI
      // can print a precise "try again in Ns" message.
      const retryAfter = res.status === 429 ? Number(res.headers.get('retry-after') ?? 0) || undefined : undefined;
      throw new ApiError(res.status, data?.error ?? `Request failed with status ${res.status}.`, retryAfter);
    }
    return data as T;
  }
}
