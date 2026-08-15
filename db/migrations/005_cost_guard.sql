-- ============================================================================
-- 005_cost_guard.sql — GRACE FREE internal cost accounting + daily cost guard
-- Target: Neon PostgreSQL (any PG 13+).
--
-- Adds the tables that enforce the internal per-user daily cost ceiling and
-- the global spending circuit breaker. All money is stored as INTEGER
-- microdollars (USD × 10⁻⁶) — never floats — so sums are exact.
--
--   * ai_usage    — one row per hosted model request (provider, model,
--                   tokens, estimated cost, UTC day) for internal accounting.
--   * daily_cost  — per-user, per-UTC-day ledger: spent + reserved micros.
--                   The server reserves budget before a request (race-safe
--                   atomic UPSERT with a cap check) and settles afterwards.
--   * global_cost — global (cross-user) ledger per period ('day' / 'month')
--                   for the hosted spending circuit breaker.
--
-- The daily ceiling itself is configuration (ZEESH_DAILY_COST_LIMIT_INR /
-- ZEESH_GLOBAL_*_COST_LIMIT_INR) and is enforced in SQL WHERE clauses by
-- src/api/costGuard.ts — no schema change needed to tune limits.
--
-- Idempotent: safe to re-run. Does not delete or alter existing data.
-- ============================================================================

-- Per-request cost accounting (internal economics — never exposed to users).
CREATE TABLE IF NOT EXISTS ai_usage (
  id                        BIGSERIAL PRIMARY KEY,
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id                UUID REFERENCES sessions(id) ON DELETE SET NULL,
  provider                  TEXT NOT NULL,
  model                     TEXT NOT NULL,
  input_tokens              INT  NOT NULL DEFAULT 0,
  cached_input_tokens       INT  NOT NULL DEFAULT 0,
  output_tokens             INT  NOT NULL DEFAULT 0,
  total_tokens              INT  NOT NULL DEFAULT 0,
  -- Estimated cost in integer microdollars (USD × 10⁻⁶) — never a float.
  estimated_cost_usd_micros BIGINT NOT NULL DEFAULT 0,
  currency                  TEXT NOT NULL DEFAULT 'USD',
  -- UTC day bucket (YYYY-MM-DD) the request belongs to (00:00 UTC boundary).
  day                       TEXT NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-user daily cost queries (the guard's hot path) + time-series scans.
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_day   ON ai_usage (user_id, day);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created_at ON ai_usage (created_at);

-- Per-user, per-UTC-day cost ledger.
-- spent   = settled cost of completed requests,
-- reserved = budget reserved for in-flight requests (worst-case estimate).
-- The invariant `spent + reserved <= daily ceiling` is enforced atomically by
-- the reservation UPSERT's WHERE clause (src/api/costGuard.ts), so concurrent
-- requests can never push a user over the ceiling.
CREATE TABLE IF NOT EXISTS daily_cost (
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day                 TEXT NOT NULL,
  spent_usd_micros    BIGINT NOT NULL DEFAULT 0,
  reserved_usd_micros BIGINT NOT NULL DEFAULT 0,
  version             INT  NOT NULL DEFAULT 0,   -- bumped on every mutation
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

-- Global hosted-spending circuit breaker (cross-user). period_type is
-- 'day' (period = YYYY-MM-DD) or 'month' (period = YYYY-MM).
CREATE TABLE IF NOT EXISTS global_cost (
  period_type         TEXT NOT NULL,   -- 'day' | 'month'
  period              TEXT NOT NULL,   -- 'YYYY-MM-DD' | 'YYYY-MM'
  spent_usd_micros    BIGINT NOT NULL DEFAULT 0,
  reserved_usd_micros BIGINT NOT NULL DEFAULT 0,
  version             INT  NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (period_type, period)
);
