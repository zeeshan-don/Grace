/**
 * Route handlers for the GRACE API (Milestones 10–11).
 *
 * Handlers use the (req, res) signature of Vercel's Node.js runtime, so they
 * can be exported directly from `api/*.ts` entrypoints. The local dev server
 * (src/api/router.ts) adapts node:http to the same shape.
 *
 * Milestone 11: shared-token auth was replaced by real user sessions
 * (POST /api/auth/register|login|logout, GET /api/auth/me). Protected
 * endpoints resolve the session via `requireSession` and scope data to the
 * authenticated user — a caller can never impersonate another user_id.
 */
import { VERSION } from '../meta.ts';
import { bearerToken, requireSession } from './auth.ts';
import { AuthError, AuthService, normalizeEmail, type AuthUser } from './authService.ts';
import { betaAccessFor } from './beta.ts';
import { getDb } from './db.ts';
import { logApiEvent } from './log.ts';
import { checkRateLimit, clientIp } from './rateLimit.ts';
import { describeServerRouter, runServerChat, type ChatRequest } from './providers.ts';
import { FreeSessionService, secondsUntilUtcMidnight, type DailySessionState, type FreeSessionRow } from './freeSessions.ts';
import { isObject, methodNotAllowed, type ApiHandler, type ApiRequest, type ApiResponse } from './types.ts';
import { UsageError, UsageService, type UsageReport } from './usage.ts';

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** GET /api/health — liveness + config probe (public). */
export const healthHandler: ApiHandler = async (req, res) => {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');

  let database: 'connected' | 'not_configured' | 'error' = 'not_configured';
  const db = getDb();
  if (db) {
    try {
      await db('SELECT 1');
      database = 'connected';
    } catch {
      database = 'error';
    }
  }

  res.status(200).json({
    status: 'ok',
    service: 'zeesh-api',
    version: VERSION,
    time: new Date().toISOString(),
    database,
    auth: process.env.DATABASE_URL ? 'configured' : 'not_configured',
  });
};

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** POST /api/auth/register — create an account and return a session token. */
export const registerHandler: ApiHandler = async (req, res) => {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'DATABASE_URL is not configured on the server.' });
  const rate = checkRateLimit('auth', `${clientIp(req.headers)}:register`);
  if (!rate.ok) return tooManyRequests(res, rate.retryAfterSeconds);
  if (!isObject(req.body)) return res.status(400).json({ error: 'Request body must be a JSON object.' });

  const email = stringField(req.body.email);
  const password = stringField(req.body.password);
  const displayName = typeof req.body.display_name === 'string' ? req.body.display_name : null;

  // Milestone 12: closed beta gate (email allowlist via ZEESH_BETA_* env).
  // Only applied to otherwise-valid attempts, so validation failures (400)
  // still win over the gate (403) for malformed input.
  const normalizedEmail = normalizeEmail(email);
  const access = betaAccessFor(normalizedEmail || email);
  if (normalizedEmail && password.length >= 8 && !access.allowed) {
    return res.status(403).json({
      error: 'GRACE is in a closed beta. Registration is currently by invitation only.',
    });
  }

  try {
    const result = await new AuthService(db).register({ email, password, displayName }, 'cli', { beta: access.isBeta });
    res.status(201).json({ user: toApiUser(result.user), token: result.token, expires_at: result.expiresAt });
  } catch (err) {
    if (err instanceof AuthError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'Could not create the account.' });
  }
};

/** POST /api/auth/login — verify credentials and return a session token. */
export const loginHandler: ApiHandler = async (req, res) => {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'DATABASE_URL is not configured on the server.' });
  const rate = checkRateLimit('auth', `${clientIp(req.headers)}:login`);
  if (!rate.ok) return tooManyRequests(res, rate.retryAfterSeconds);
  if (!isObject(req.body)) return res.status(400).json({ error: 'Request body must be a JSON object.' });

  const email = stringField(req.body.email);
  const password = stringField(req.body.password);
  try {
    const result = await new AuthService(db).login({ email, password }, 'cli');
    res.status(200).json({ user: toApiUser(result.user), token: result.token, expires_at: result.expiresAt });
  } catch (err) {
    if (err instanceof AuthError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'Could not log in.' });
  }
};

/** POST /api/auth/logout — invalidate the presented session. */
export const logoutHandler: ApiHandler = async (req, res) => {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'DATABASE_URL is not configured on the server.' });
  const auth = await requireSession(req, db);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  await new AuthService(db).logout(bearerToken(req));
  res.status(200).json({ logged_out: true });
};

/** GET /api/auth/me — current user from the session (used by `whoami`). */
export const meHandler: ApiHandler = async (req, res) => {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'DATABASE_URL is not configured on the server.' });
  const auth = await requireSession(req, db);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  res.status(200).json({ user: toApiUser(auth.user) });
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** POST/GET /api/usage — usage recording + per-user recent usage (session auth). */
export const usageHandler: ApiHandler = async (req, res) => {
  if (req.method === 'POST') return recordUsage(req, res);
  if (req.method === 'GET') return listUsage(req, res);
  return methodNotAllowed(res, 'POST, GET');
};

async function recordUsage(req: ApiRequest, res: ApiResponse): Promise<void> {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'DATABASE_URL is not configured on the server.' });
  const auth = await requireSession(req, db);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const rate = checkRateLimit('api', `${clientIp(req.headers)}:usage`);
  if (!rate.ok) return tooManyRequests(res, rate.retryAfterSeconds);
  if (!isObject(req.body)) return res.status(400).json({ error: 'Request body must be a JSON object.' });

  try {
    // The user_id in the body is ignored — the session is the source of truth,
    // so a caller can never report usage as someone else.
    const report: UsageReport = { ...(req.body as unknown as UsageReport), user_id: auth.user.id };
    const { runId } = await new UsageService(db).recordUsage(report);
    // Observability (M12): model/token/run facts, scrubbed — never the prompt.
    logApiEvent({
      method: 'POST',
      path: '/api/usage',
      status: 201,
      latencyMs: 0,
      userId: auth.user.id,
      model: report.model,
      tokens: { input: report.input_tokens, output: report.output_tokens },
      runId,
    });
    res.status(201).json({ recorded: true, run_id: runId });
  } catch (err) {
    if (err instanceof UsageError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'Could not record usage.' });
  }
}

async function listUsage(req: ApiRequest, res: ApiResponse): Promise<void> {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'DATABASE_URL is not configured on the server.' });
  const auth = await requireSession(req, db);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const raw = Number(req.query?.limit ?? 20);
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 100) : 20;
  try {
    const rows = await new UsageService(db).recentUsageForUser(auth.user.id, limit);
    // GRACE FREE: the daily session summary (Milestone 13) rides along so the
    // CLI can render "Session X / 6 · time remaining · today's usage" without
    // trusting any client-side state. getState is read-only — it never starts
    // or consumes a session.
    const sessionState = await new FreeSessionService(db).getState(auth.user.id);
    res.status(200).json({ usage: rows, ...sessionState });
  } catch {
    res.status(500).json({ error: 'Could not load usage.' });
  }
}

// ---------------------------------------------------------------------------
// Session status / end (server-authoritative free sessions)
// ---------------------------------------------------------------------------

/**
 * GET /api/session/status — the server-authoritative session state:
 * status, timestamps, daily quota, and the router's provider/model info.
 * Read-only: it never starts or ends a session (unlike /api/provider).
 */
export const sessionStatusHandler: ApiHandler = async (req, res) => {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'DATABASE_URL is not configured on the server.' });
  const auth = await requireSession(req, db);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const svc = new FreeSessionService(db);
  const state = await svc.getState(auth.user.id);
  const last = await svc.lastSessionRow(auth.user.id);
  const router = describeServerRouter();
  res.status(200).json({
    session: {
      ...state,
      id: last?.id ?? null,
      status: sessionStatusLabel(last, state),
      started_at: last?.started_at ?? null,
      expires_at: last?.expires_at ?? null,
      provider: router.primary,
      model: router.model,
      model_router: router.providers,
    },
  });
};

/**
 * POST /api/session/end — explicitly end the active session. The server is
 * the only writer: the CLI can only request an end, never fabricate one.
 * Ending never starts a replacement session.
 */
export const endSessionHandler: ApiHandler = async (req, res) => {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'DATABASE_URL is not configured on the server.' });
  const auth = await requireSession(req, db);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const svc = new FreeSessionService(db);
  const state = await svc.endActiveSession(auth.user.id);
  const last = await svc.lastSessionRow(auth.user.id);
  res.status(200).json({
    session: {
      ...state,
      id: last?.id ?? null,
      status: sessionStatusLabel(last, state),
      started_at: last?.started_at ?? null,
      expires_at: last?.expires_at ?? null,
    },
  });
};

/**
 * Session state label for read-only status:
 *   - 'active'    a session is live right now,
 *   - 'ended'     the last session was explicitly ended early
 *                 (ended_at < expires_at) — never reused,
 *   - 'expired'   the last session ran out naturally (or was lazy-ended at
 *                 its expiry),
 *   - 'none'      no session today.
 */
function sessionStatusLabel(last: FreeSessionRow | null, state: DailySessionState): string {
  if (last !== null && state.currentSession !== null) return 'active';
  if (last !== null && last.ended_at !== null) {
    const ended = new Date(last.ended_at).getTime();
    const expires = new Date(last.expires_at).getTime();
    // Explicit end marks ended_at = now (< expires_at); natural expiry lazy-ends
    // with ended_at = expires_at. The memory test db mirrors both.
    if (Number.isFinite(ended) && Number.isFinite(expires) && ended < expires) return 'ended';
  }
  if (state.sessionsUsed > 0) return 'expired';
  return 'none';
}

// ---------------------------------------------------------------------------
// Provider proxy
// ---------------------------------------------------------------------------

/** POST /api/provider — proxy a chat completion (session auth). */
export const providerHandler: ApiHandler = async (req, res) => {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'DATABASE_URL is not configured on the server.' });
  const auth = await requireSession(req, db);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
  const rate = checkRateLimit('api', `${clientIp(req.headers)}:provider`);
  if (!rate.ok) return tooManyRequests(res, rate.retryAfterSeconds);
  if (!isObject(req.body)) return res.status(400).json({ error: 'Request body must be a JSON object.' });

  // Validate the payload BEFORE the free-plan gate so a malformed request can
  // never consume (or start) a session slot.
  const chatRequest = req.body as unknown as ChatRequest;
  if (!Array.isArray(chatRequest.messages) || chatRequest.messages.length === 0) {
    return res.status(400).json({ error: '"messages" must be a non-empty array.' });
  }

  // GRACE FREE (Milestone 13): the free-plan gate is authoritative and runs
  // BEFORE any provider call, so exhausted/expired accounts never reach the
  // model. An expired session with quota left auto-starts the next one; the
  // response tells the CLI a new session began (session.startedNew).
  const gate = await new FreeSessionService(db).ensureActiveSession(auth.user.id);
  if (!gate.ok) {
    // "All N sessions used" — Retry-After hints at the next UTC day, and the
    // current state rides along so the rejection is self-describing.
    res.setHeader('Retry-After', String(secondsUntilUtcMidnight()));
    return res.status(gate.status).json({ error: gate.error, code: gate.code, session: gate.state });
  }

  const outcome = await runServerChat(chatRequest);
  if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });

  res.status(200).json({
    content: outcome.result.content,
    tool_calls: outcome.result.toolCalls,
    usage: outcome.result.usage,
    finish_reason: outcome.result.finishReason,
    // Which provider actually served the request (after router fallback), so
    // the CLI can show e.g. "Provider: NVIDIA NIM" without any key.
    provider_id: outcome.providerId,
    provider_label: outcome.providerLabel,
    // The current free-plan state (and whether this request rolled the user
    // into a fresh session) so the CLI can render the quota line.
    session: { ...gate.state, startedNew: gate.startedNew },
  });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tooManyRequests(res: ApiResponse, retryAfterSeconds: number): void {
  res
    .setHeader('Retry-After', String(retryAfterSeconds))
    .status(429)
    .json({ error: `Too many requests. Try again in ${retryAfterSeconds}s.` });
}

/** Coerce an unknown body field to a string (validation happens in AuthService). */
function stringField(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Serialize an AuthUser to the API's snake_case shape. */
function toApiUser(user: AuthUser): { id: string; email: string; display_name: string | null } {
  return { id: user.id, email: user.email, display_name: user.displayName };
}
