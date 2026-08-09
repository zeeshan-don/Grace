-- ============================================================================
-- 002_auth.sql — user authentication (Milestone 11)
-- Target: Neon PostgreSQL (any PG 13+).
--
-- Adds the password hash column to `users` (created in 001_init.sql) and an
-- index on sessions.token_hash so bearer lookups stay fast.
--
-- Security invariants:
--   * users.password_hash  — scrypt hash ("salt:hash"), never a plaintext
--                            password. Set by src/api/password.ts.
--   * sessions.token_hash  — SHA-256 of the session token. The raw token
--                            exists only on the client (CLI), never here.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- scrypt hash of the user's password ("<salt-hex>:<hash-hex>"); NULL for
-- accounts created before Milestone 11 (they must set a password to log in).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Lookups by bearer token hash (POST /api/auth/me, usage, provider).
-- UNIQUE: a token hash identifies exactly one session (defense in depth on
-- top of the 256-bit random tokens from src/api/sessions.ts).
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash
  ON sessions (token_hash);

-- Find/expire a user's sessions.
CREATE INDEX IF NOT EXISTS idx_sessions_user_id
  ON sessions (user_id, expires_at);
