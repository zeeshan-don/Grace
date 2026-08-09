# Database (Milestones 10–12 — implemented)

The cloud backend records accounts, sessions, usage and economics in **Neon
PostgreSQL**. The schema lives in [`db/migrations/`](../db/migrations/) and is
wired into the API via the `DATABASE_URL` environment variable
(`src/api/db.ts`). The CLI stays fully local and offline-capable; once the user
logs in (`myagent login`) it reports usage through the API.

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

## Schema

| Table | Purpose |
| ----- | ------- |
| `users` | Product accounts (id, email, display name, `password_hash` — scrypt, never plaintext, `is_beta` — closed-beta flag) |
| `sessions` | A logged-in user, possibly on multiple devices. Stores `token_hash` (SHA-256 of the session token — never the raw token) with `device`, `created_at`, `expires_at` |
| `agent_runs` | One agent run (one user request → final answer) — status, model, `agent_turns`, `tool_calls`, tokens, `execution_time_ms`, `client_run_id` idempotency key |
| `usage` | Per-run token usage rows, the source for cost calculation |
| `models` | Model catalog with placeholder pricing per 1M tokens |
| `user_economics` | View: runs, total tokens and estimated AI cost per user |

`agent_runs` + `usage` together track everything the milestones require:

```
user_id · model · input_tokens · output_tokens · agent_turns · created_at (timestamp) · execution_time_ms
```

The `user_economics` view joins runs against `models` pricing to estimate AI
cost per user — the input for the economics milestone (13) that decides ad
pricing vs. free-tier limits (Milestone 14). Pricing assumptions live in the
`models` table (documented in `docs/economics.md`) and are editable by upsert
— they are not hardcoded in application code.

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
to the backend whenever a valid session exists (`myagent login`); reporting is
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
