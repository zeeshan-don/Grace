-- ============================================================================
-- 004_free_sessions.sql — ZEESH FREE daily session system (Milestone 13)
-- Target: Neon PostgreSQL (any PG 13+).
--
-- Adds the `free_sessions` table that enforces the free plan:
--   * 3 sessions per user per day   (session_number 1..3)
--   * 60 minutes per session        (started_at → expires_at)
--   * 3 hours/day max               (3 × 60 min)
--
-- The day bucket (`day`) is the UTC date the session STARTED in
-- (YYYY-MM-DD). The server is the only writer and the only source of truth:
-- the CLI stores nothing about sessions, so restarting it or deleting local
-- files can never reset the daily quota.
--
-- UNIQUE (user_id, day, session_number) makes the server-side "start the next
-- session" race-safe: concurrent requests that both pick session N collide on
-- this constraint and the service retries with the new MAX — see
-- src/api/freeSessions.ts.
--
-- Idempotent: safe to re-run. Does not delete or alter existing data.
-- ============================================================================

CREATE TABLE IF NOT EXISTS free_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- UTC date (YYYY-MM-DD) the session belongs to. The day boundary is
  -- deliberately UTC so quota behavior is identical for every user regardless
  -- of their timezone ("day" = the server's authoritative UTC day).
  day            TEXT NOT NULL,
  -- 1-based position in the day (1..N; N = ZEESH_SESSIONS_PER_DAY, default 3).
  -- The upper bound is enforced by the service, not the schema, so ops can
  -- tune the limit without a migration.
  session_number INT  NOT NULL CHECK (session_number > 0),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- started_at + session duration (default 60 minutes). A session is
  -- "active" while now() < expires_at; otherwise it is expired/ended.
  expires_at     TIMESTAMPTZ NOT NULL,
  -- Set lazily when the server detects the session has expired.
  ended_at       TIMESTAMPTZ,
  UNIQUE (user_id, day, session_number)
);

-- Today's sessions per user (the hot path: gate + state computation).
CREATE INDEX IF NOT EXISTS idx_free_sessions_user_day
  ON free_sessions (user_id, day);
