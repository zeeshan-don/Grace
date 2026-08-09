/**
 * Route handlers for the ZEESH AI API (Milestones 10–11).
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
import { runServerChat, type ChatRequest } from './providers.ts';
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
      error: 'ZEESH AI is in a closed beta. Registration is currently by invitation only.',
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
    res.status(200).json({ usage: rows });
  } catch {
    res.status(500).json({ error: 'Could not load usage.' });
  }
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

  const outcome = await runServerChat(req.body as unknown as ChatRequest);
  if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });

  res.status(200).json({
    content: outcome.result.content,
    tool_calls: outcome.result.toolCalls,
    usage: outcome.result.usage,
    finish_reason: outcome.result.finishReason,
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
