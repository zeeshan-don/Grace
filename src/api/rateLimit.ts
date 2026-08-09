/**
 * In-memory sliding-window rate limiter (Milestone 11).
 *
 * Auth endpoints (login/register) get a stricter budget per client IP than
 * general API calls. Limits are read from the environment so deployments and
 * tests can tune them without code changes:
 *   ZEESH_AUTH_RATE_LIMIT_MAX  (default 50 attempts / 15 min per IP)
 *   ZEESH_API_RATE_LIMIT_MAX   (default 300 requests / 1 min per IP)
 *
 * The limiter is per-process; a shared store (Redis/Upstash) is a Milestone
 * 12+ concern once multiple serverless instances exist.
 */
export type RateScope = 'auth' | 'api';

const AUTH_WINDOW_MS = 15 * 60 * 1000;
const API_WINDOW_MS = 60 * 1000;

export interface RateLimitCheck {
  ok: boolean;
  retryAfterSeconds: number;
}

export class RateLimiter {
  readonly windowMs: number;
  readonly max: number;
  private readonly hits = new Map<string, number[]>();

  constructor(windowMs: number, max: number) {
    this.windowMs = windowMs;
    this.max = max;
  }

  check(key: string): RateLimitCheck {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000));
      return { ok: false, retryAfterSeconds };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { ok: true, retryAfterSeconds: 0 };
  }

  reset(): void {
    this.hits.clear();
  }
}

const limiters = new Map<RateScope, RateLimiter>();

function limiterFor(scope: RateScope): RateLimiter {
  const windowMs = scope === 'auth' ? AUTH_WINDOW_MS : API_WINDOW_MS;
  const envMax =
    scope === 'auth'
      ? Number(process.env.ZEESH_AUTH_RATE_LIMIT_MAX ?? 50)
      : Number(process.env.ZEESH_API_RATE_LIMIT_MAX ?? 300);
  const max = Number.isFinite(envMax) && envMax > 0 ? Math.floor(envMax) : 300;
  const existing = limiters.get(scope);
  if (existing && existing.windowMs === windowMs && existing.max === max) return existing;
  const created = new RateLimiter(windowMs, max);
  limiters.set(scope, created);
  return created;
}

/** Check a request against the limiter for its scope. */
export function checkRateLimit(scope: RateScope, key: string): RateLimitCheck {
  return limiterFor(scope).check(key);
}

/** Best-effort client identity from proxy headers (falls back to 'local'). */
export function clientIp(headers: Record<string, string | string[] | undefined>): string {
  const fwd = headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0]?.trim() ?? 'local';
  const real = headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  return 'local';
}

/** Test hook: clear limiter state (tests also set ZEESH_*_RATE_LIMIT_MAX). */
export function resetRateLimiters(): void {
  for (const limiter of limiters.values()) limiter.reset();
}
