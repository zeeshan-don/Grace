-- ============================================================================
-- 003_closed_beta.sql — closed beta (Milestone 12) + production indexes
-- Target: Neon PostgreSQL (any PG 13+).
--
-- Adds:
--   * users.is_beta            — flags closed-beta accounts (set by the API
--                                from ZEESH_BETA_MODE / ZEESH_BETA_ALLOWLIST).
--   * explicit timestamp       — indexes for the time-series/observability
--     indexes                   queries (created_at) that the composite
--                                (user_id, created_at) indexes don't cover.
--
-- Already covered by earlier migrations (kept here for the checklist):
--   * user_id lookups  → idx_agent_runs_user_created, idx_usage_user_created
--   * session/token    → idx_sessions_token_hash (UNIQUE), idx_sessions_user_id
--   * client_run_id    → UNIQUE constraint on agent_runs.client_run_id
--   * users.email      → UNIQUE constraint
--
-- Idempotent: safe to re-run. Does not delete or alter existing data.
-- ============================================================================

-- Beta-tester flag (used by the closed-beta registration gate).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_beta BOOLEAN NOT NULL DEFAULT false;

-- Timestamp indexes (frequent "recent activity" queries).
CREATE INDEX IF NOT EXISTS idx_agent_runs_created_at ON agent_runs (created_at);
CREATE INDEX IF NOT EXISTS idx_usage_created_at       ON usage (created_at);
CREATE INDEX IF NOT EXISTS idx_users_created_at       ON users (created_at);

-- Session expiry cleanup / lookups.
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at    ON sessions (expires_at);
