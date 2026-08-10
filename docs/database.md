# Database (Milestones 10–12 — implemented)

The cloud backend records accounts, sessions, usage and economics in **Neon
PostgreSQL**. The schema lives in [`db/migrations/`](../db/migrations/) and is
wired into the API via the `DATABASE_URL` environment variable
(`src/api/db.ts`). The CLI stays fully local and offline-capable; once the user
logs in (`zeesh login`) it reports usage through the API.

## Design goals

- **Prove economics**: compute AI cost per user, infra cost per user, ad
  revenue per user, and profit/loss per user.
- **Never expose provider keys to clients**: the backend owns `GROQ_API_KEY`
  (or equivalent) and proxies model calls (`src/api/providers.ts`).
- **Track every agent turn** so per-user cost is auditable.
- **Never store plaintext credentials**: passwords are scrypt-hashed
  (`users.password_hash`), session tokens are stored as SHA-256 only
  (`sessions.token_hash`).

## Applying the schema

Choose one:

```bash
# from the project root (requires the psql client)
psql "$DATABASE_URL" -f db/migrations/001_init.sql
psql "$DATABASE_URL" -f db/migrations/002_auth.sql
psql "$DATABASE_URL" -f db/migrations/003_closed_beta.sql
psql "$DATABASE_URL" -f db/migrations/004_free_sessions.sql
```

or paste each file into the **Neon SQL Editor** (console.neon.tech → SQL
Editor). Both migrations are idempotent (safe to re-run).

Get a database:

1. Sign up / in at <https://console.neon.tech> and create a project.
2. Copy the pooled connection string (Project → Connection Details).
3. Add it as `DATABASE_URL` in the server environment (`.env` locally, Vercel
   environment variables in production).

## Migrations

| File | Milestone | What it adds |
| ---- | --------- | ------------ |
| `001_init.sql` | 10 | `users`, `sessions`, `agent_runs`, `usage`, `models`, `user_economics` view |
| `002_auth.sql` | 11 | `users.password_hash`, indexes on `sessions.token_hash` and `(user_id, expires_at)` |
| `003_closed_beta.sql` | 12 | `users.is_beta`, timestamp indexes (`agent_runs/usage/users.created_at`, `sessions.expires_at`) |
| `004_free_sessions.sql` | 13 | `free_sessions` (ZEESH FREE daily session quota: 6 sessions/day × 60 min, unique per user/day/number) |

## Schema

| Table | Purpose |
| ----- | ------- |
| `users` | Product accounts (id, email, display name, `password_hash` — scrypt, never plaintext, `is_beta` — closed-beta flag) |
| `sessions` | A logged-in user, possibly on multiple devices. Stores `token_hash` (SHA-256 of the session token — never the raw token) with `device`, `created_at`, `expires_at` |
| `agent_runs` | One agent run (one user request → final answer) — status, model, `agent_turns`, `tool_calls`, tokens, `execution_time_ms`, `client_run_id` idempotency key |
| `usage` | Per-run token usage rows, the source for cost calculation |
| `models` | Model catalog with placeholder pricing per 1M tokens |
| `user_economics` | View: runs, total tokens and estimated AI cost per user |
| `free_sessions` | ZEESH FREE quota rows — one per daily session (`day` = UTC date, `session_number` 1..N, `started_at`, `expires_at`, `ended_at`) |

`agent_runs` + `usage` together track everything the milestones require:

```
user_id · model · input_tokens · output_tokens · agent_turns · created_at (timestamp) · execution_time_ms
```

The `user_economics` view joins runs against `models` pricing to estimate AI
cost per user — the input for the economics milestone (15) that decides ad
pricing (Milestone 16); free-tier limits themselves are already live
(Milestone 13, `free_sessions`). Pricing assumptions live in the `models`
table (documented in `docs/economics.md`) and are editable by upsert — they
are not hardcoded in application code.

## Authentication flow (Milestone 11)

```
CLI ──POST /api/auth/register|login──► Backend ──► Neon: verify users.password_hash
CLI ◄── { user, token, expires_at } ── Backend     Neon: sessions.token_hash = SHA-256(token)
CLI ──POST /api/usage (Bearer token)──► Backend ──► Neon: agent_runs + usage (scoped to the session user)
```

- Passwords: `scrypt(password, random-salt)` → `"<salt>:<hash>"` stored in
  `users.password_hash`. Verification is constant-time (`src/api/password.ts`).
- Session tokens: `crypto.randomBytes(32)` hex, handed to the client once;
  only `SHA-256(token)` is stored in `sessions.token_hash`
  (`src/api/sessions.ts`).
- Sessions expire after 30 days (`sessions.expires_at`).

## Flow

```
CLI ──POST /api/usage──► Backend ──► Neon: agent_runs + usage rows
CLI ──POST /api/provider──► Backend ──► Model router ──► AI provider (key stays server-side)
```

The CLI keeps working offline (local key) while the backend path adds accounts,
rate limiting, central usage tracking and ad slots. The CLI now reports usage
to the backend whenever a valid session exists (`zeesh login`); reporting is
non-fatal — a backend outage never breaks the local agent.

## Closed beta (Milestone 12)

- **Gate**: `ZEESH_BETA_MODE=closed` + `ZEESH_BETA_ALLOWLIST` (comma-separated
  emails). Non-allowlisted registrations get `403`; existing accounts are
  never locked out. See `src/api/beta.ts`.
- **Flag**: allowlisted registrations set `users.is_beta = true` so beta
  testers can be identified and costed separately (`user_economics`).
- **Indexes**: `003_closed_beta.sql` adds timestamp indexes for
  time-series/observability queries. Lookups by `user_id`, session token hash
  and `client_run_id` were already indexed (see the migration header for the
  full checklist).

## Free plan sessions (Milestone 13)

The free tier (`ZEESH FREE`) is enforced by the backend via the
`free_sessions` table, written only by `src/api/freeSessions.ts`:

- One row per session: `user_id`, the UTC `day` the session started in,
  `session_number` (1-based), `started_at`, `expires_at` (start + 60 min) and a
  lazily-set `ended_at` when the server detects the session expired.
- `UNIQUE (user_id, day, session_number)` is the concurrency guard: if two
  requests both try to start session N, one wins and the other retries with the
  new `MAX` — the daily cap can never be exceeded.
- The day boundary is **00:00 UTC** (server-authoritative); sessions belong to
  the day they started in, so a session opened just before midnight rolls into
  the next day cleanly.
- The CLI stores nothing about sessions — deleting `~/.zeesh/` or restarting
  the CLI cannot reset the quota.
