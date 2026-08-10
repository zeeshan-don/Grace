-- ============================================================================
-- 001_init.sql — initial schema for the ZEESH AI backend (Milestone 10)
-- Target: Neon PostgreSQL (any PG 13+; gen_random_uuid is built in).
--
-- Apply with either:
--   psql "$DATABASE_URL" -f db/migrations/001_init.sql
-- or paste this file into the Neon SQL editor (console.neon.tech → SQL Editor).
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- Users of the product
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ
);

-- Sessions (a logged-in user, possibly on multiple devices)
CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,          -- only a hash, never the token
  device        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);

-- One agent run (one user request → final answer)
CREATE TABLE IF NOT EXISTS agent_runs (
  id                BIGSERIAL PRIMARY KEY,
  client_run_id     TEXT UNIQUE,        -- CLI-generated idempotency key
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id        UUID REFERENCES sessions(id) ON DELETE SET NULL,
  project_type      TEXT,               -- node / python / … (reported by CLI)
  prompt            TEXT,
  status            TEXT NOT NULL DEFAULT 'running', -- running | done | error | denied
  model             TEXT NOT NULL,
  agent_turns       INT  NOT NULL DEFAULT 0,
  tool_calls        INT  NOT NULL DEFAULT 0,
  input_tokens      INT  NOT NULL DEFAULT 0,
  output_tokens     INT  NOT NULL DEFAULT 0,
  execution_time_ms INT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_user_created ON agent_runs (user_id, created_at DESC);

-- Per-run token usage (also feeds cost calculation)
CREATE TABLE IF NOT EXISTS usage (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id        BIGINT REFERENCES agent_runs(id) ON DELETE CASCADE,
  model         TEXT NOT NULL,
  input_tokens  INT  NOT NULL DEFAULT 0,
  output_tokens INT  NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(12,8),         -- filled by the billing pipeline (M15)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage (user_id, created_at DESC);

-- Model catalog (which providers/models exist and their pricing)
CREATE TABLE IF NOT EXISTS models (
  id             TEXT PRIMARY KEY,      -- e.g. 'openai/gpt-oss-120b'
  provider       TEXT NOT NULL,         -- groq | gemini | anthropic | openai | …
  input_ppm_usd  NUMERIC(12,6) NOT NULL DEFAULT 0,  -- price per 1M input tokens
  output_ppm_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  context_tokens INT NOT NULL DEFAULT 0,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the models the agent uses today. Prices are placeholder estimates and
-- get replaced by the billing pipeline (Milestone 15) with real numbers.
INSERT INTO models (id, provider, input_ppm_usd, output_ppm_usd, context_tokens)
VALUES
  ('openai/gpt-oss-120b',      'groq', 0.25, 1.00, 131072),
  ('qwen/qwen3.6-27b',         'groq', 0.10, 0.40, 131072),
  ('llama-3.3-70b-versatile',  'groq', 0.59, 0.79, 131072),
  ('llama-3.1-8b-instant',     'groq', 0.05, 0.08, 131072)
ON CONFLICT (id) DO NOTHING;

-- Cost per user (drives the economics milestone: M15)
CREATE OR REPLACE VIEW user_economics AS
SELECT
  u.id AS user_id,
  COUNT(DISTINCT r.id)                   AS runs,
  SUM(r.input_tokens + r.output_tokens)  AS total_tokens,
  ROUND(SUM(
    (r.input_tokens::numeric  / 1000000) * COALESCE(m.input_ppm_usd, 0)
  + (r.output_tokens::numeric / 1000000) * COALESCE(m.output_ppm_usd, 0)
  ), 6)                                  AS ai_cost_usd
FROM users u
LEFT JOIN agent_runs r ON r.user_id = u.id
LEFT JOIN models m    ON m.id = r.model
GROUP BY u.id;
