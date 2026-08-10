/**
 * GRACE FREE daily session service (Milestone 13).
 *
 * Enforces the free plan on the server — the CLI never stores or trusts any
 * session state, so restarting it or deleting local files can never reset the
 * daily quota:
 *
 *   * 6 sessions per user per day        (ZEESH_SESSIONS_PER_DAY, default 6)
 *   * 60 minutes per session             (ZEESH_SESSION_DURATION_MINUTES, default 60)
 *   * 6 hours / day max                  (sessionsPerDay × sessionDuration)
 *   * day boundary = 00:00 UTC           (server-authoritative, timezone-independent)
 *
 * State lives in Neon `free_sessions` (db/migrations/004_free_sessions.sql):
 * one row per session with a UNIQUE (user_id, day, session_number) constraint,
 * which is what makes the "start the next session" step race-safe (concurrent
 * requests that both pick the same number collide → the loser retries with the
 * new MAX).
 *
 * API:
 *   - `getState(userId)`            read-only summary for GET /api/usage.
 *   - `ensureActiveSession(userId)` the authoritative gate for /api/provider:
 *       · active session   → serve the request inside it,
 *       · expired / none   → auto-start the next session if quota remains
 *                            ("automatically move the user to the next
 *                            session"), otherwise refuse with
 *                            `{ code: 'daily_limit_exhausted' }`.
 */
import type { Db, Row } from './db.ts';

/** Default free-plan limits (overridable per deployment via env, like rate limits). */
export const DEFAULT_SESSIONS_PER_DAY = 6;
export const DEFAULT_SESSION_DURATION_MS = 60 * 60 * 1000; // 60 minutes

/** A row of `free_sessions` as read by this service. */
export interface FreeSessionRow {
  id: string;
  user_id: string;
  /** UTC day bucket (YYYY-MM-DD) the session belongs to. */
  day: string;
  session_number: number;
  /** ISO timestamps. */
  started_at: string;
  expires_at: string;
  ended_at: string | null;
}

/**
 * The daily free-plan summary. Mirrored on the CLI side as
 * `DailySessionState` in src/auth/client.ts — keep both in sync.
 */
export interface DailySessionState {
  sessionsUsed: number;
  sessionsRemaining: number;
  /** Number of the active session, or null when none is active (expired/none). */
  currentSession: number | null;
  sessionStartedAt: string | null;
  sessionExpiresAt: string | null;
  /** Wall-clock seconds consumed today (expired sessions count in full). */
  dailyUsedSeconds: number;
  dailyLimitSeconds: number;
}

/** Result of the /api/provider gate. */
export type SessionGate =
  | { ok: true; state: DailySessionState; startedNew: boolean }
  | { ok: false; status: number; code: 'daily_limit_exhausted'; error: string; state: DailySessionState };

export interface FreeSessionServiceOptions {
  /** Injectable clock (tests). Defaults to `new Date()`. */
  now?: () => Date;
}

const MAX_START_ATTEMPTS = 10;

/**
 * The UTC date bucket a session belongs to (YYYY-MM-DD). The day boundary is
 * deliberately UTC — the server's authoritative day is the same for every
 * user regardless of timezone, so quota math is unambiguous.
 */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Seconds until the next UTC midnight (used for the 429 Retry-After header). */
export function secondsUntilUtcMidnight(now: Date = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

/** Read an env override as a positive integer, falling back to `fallback`. */
function envPositiveInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export class FreeSessionService {
  private readonly db: Db;
  private readonly options: FreeSessionServiceOptions;

  constructor(db: Db, options: FreeSessionServiceOptions = {}) {
    this.db = db;
    this.options = options;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private get sessionsPerDay(): number {
    return envPositiveInt('ZEESH_SESSIONS_PER_DAY', DEFAULT_SESSIONS_PER_DAY);
  }

  private get sessionDurationMs(): number {
    return envPositiveInt('ZEESH_SESSION_DURATION_MINUTES', DEFAULT_SESSION_DURATION_MS / 60_000) * 60_000;
  }

  // -------------------------------------------------------------------------
  // Read-only state (GET /api/usage) — never mutates.
  // -------------------------------------------------------------------------

  /** Daily free-plan summary for a user, computed from Neon. */
  async getState(userId: string): Promise<DailySessionState> {
    const now = this.now();
    const rows = await this.sessionRows(userId, utcDay(now));
    return this.computeState(rows, now);
  }

  /** Authoritative gate for /api/provider (may auto-start the next session). */
  async ensureActiveSession(userId: string): Promise<SessionGate> {
    const now = this.now();
    const day = utcDay(now);
    const limit = this.sessionsPerDay;

    // Bounded retries: concurrent requests that pick the same session_number
    // collide on the UNIQUE constraint (SQLSTATE 23505) and re-run against the
    // new MAX. With limit slots per day and eager re-reads, a request never
    // needs more than a couple of attempts.
    for (let attempt = 0; attempt < MAX_START_ATTEMPTS; attempt += 1) {
      const rows = await this.sessionRows(userId, day);
      const last = rows[rows.length - 1];

      if (last && isActive(last, now)) {
        // Current session is still live — serve inside it.
        return { ok: true, state: this.computeState(rows, now), startedNew: false };
      }

      if (rows.length >= limit) {
        // All sessions for today are used up (and the last one is expired).
        if (last) await this.markEnded(last); // lazy end: session expired
        return {
          ok: false,
          status: 429,
          code: 'daily_limit_exhausted',
          error:
            `You have used all ${limit} free sessions for today (${Math.round((limit * this.sessionDurationMs) / 3_600_000)}h max). ` +
            'New sessions unlock at 00:00 UTC. Thanks for using GRACE FREE.',
          // The state rides along so the rejection is self-describing (the
          // CLI can render "Session 6/6" from the 429 itself).
          state: this.computeState(rows, now),
        };
      }

      // Expired session (or none yet) + quota remains → auto-start the next.
      const sessionNumber = rows.length + 1;
      const startedAt = now;
      const expiresAt = new Date(now.getTime() + this.sessionDurationMs);
      try {
        const inserted = await this.db(
          `INSERT INTO free_sessions (user_id, day, session_number, started_at, expires_at)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, user_id, day, session_number, started_at, expires_at, ended_at`,
          [userId, day, sessionNumber, startedAt.toISOString(), expiresAt.toISOString()],
        );
        const row = inserted[0];
        if (!row) throw new Error('Could not start a free session.');
        // The session we just replaced expired — mark it ended (lazy expiry).
        if (last) await this.markEnded(last);
        const all = [...rows, toFreeSessionRow(row)];
        return { ok: true, state: this.computeState(all, now), startedNew: true };
      } catch (err) {
        // Unique violation → another request started this number first; retry.
        if (isUniqueViolation(err)) continue;
        throw err;
      }
    }

    // Retry budget exhausted — most likely the day filled up under contention.
    const rows = await this.sessionRows(userId, day);
    if (rows.length >= limit) {
      return {
        ok: false,
        status: 429,
        code: 'daily_limit_exhausted',
        error: `You have used all ${limit} free sessions for today. New sessions unlock at 00:00 UTC.`,
        state: this.computeState(rows, now),
      };
    }
    throw new Error('Could not start a free session.');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async sessionRows(userId: string, day: string): Promise<FreeSessionRow[]> {
    const rows = await this.db(
      `SELECT id, user_id, day, session_number, started_at, expires_at, ended_at
         FROM free_sessions
        WHERE user_id = $1 AND day = $2
        ORDER BY session_number ASC`,
      [userId, day],
    );
    return rows.map(toFreeSessionRow);
  }

  /** Mark a session ended (idempotent) — the DB stays an explicit record. */
  private async markEnded(row: FreeSessionRow): Promise<void> {
    await this.db('UPDATE free_sessions SET ended_at = expires_at WHERE id = $1 AND ended_at IS NULL', [row.id]);
  }

  /** Derive the daily summary from the day's rows. */
  private computeState(rows: FreeSessionRow[], now: Date): DailySessionState {
    const limit = this.sessionsPerDay;
    const durationMs = this.sessionDurationMs;
    const nowMs = now.getTime();

    let usedSeconds = 0;
    for (const row of rows) {
      const start = new Date(row.started_at).getTime();
      const end = new Date(row.expires_at).getTime();
      // Elapsed so far, capped at the session's own expiry (60 min max each).
      const elapsedMs = Math.min(nowMs, end) - start;
      if (elapsedMs > 0) usedSeconds += elapsedMs;
    }
    // Never exceed the daily cap (guard against clock skew / overlapping rows).
    const dailyLimitSeconds = Math.round((limit * durationMs) / 1000);
    const dailyUsedSeconds = Math.min(Math.round(usedSeconds / 1000), dailyLimitSeconds);

    const last = rows[rows.length - 1];
    const active = last !== undefined && isActive(last, now);

    return {
      sessionsUsed: rows.length,
      sessionsRemaining: Math.max(0, limit - rows.length),
      currentSession: active ? last.session_number : null,
      sessionStartedAt: active ? last.started_at : null,
      sessionExpiresAt: active ? last.expires_at : null,
      dailyUsedSeconds,
      dailyLimitSeconds,
    };
  }
}

/** A session is active while now < expires_at. */
function isActive(row: FreeSessionRow, now: Date): boolean {
  const expiresAt = new Date(row.expires_at).getTime();
  return !Number.isNaN(expiresAt) && expiresAt > now.getTime();
}

/** Postgres UNIQUE violation (SQLSTATE 23505). The memory test db mirrors it. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

/** Map a raw db row to the typed shape (numbers are returned as such by Neon). */
function toFreeSessionRow(row: Row): FreeSessionRow {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    day: String(row.day),
    session_number: Number(row.session_number),
    started_at: String(row.started_at),
    expires_at: String(row.expires_at),
    ended_at: row.ended_at == null ? null : String(row.ended_at),
  };
}
