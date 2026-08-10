# GRACE API (Milestones 10–12)

The cloud backend foundation for accounts, usage tracking, model routing and
the ad-supported free business model.

```
LOCAL CLI  →  GRACE API  →  Vercel  →  Neon PostgreSQL  →  AI providers
```

The local CLI keeps working offline with its own local Groq key; once the user
runs `grace login`, the CLI also authenticates to this API and reports usage
(and can proxy model calls through it). **Deployment is documented and ready**
(see `docs/deployment.md`) but has not been performed yet — no credentials are
available in this environment.

## Architecture

- `src/api/` — the API implementation (shared by local + serverless).
  - `handlers.ts` — route handlers using Vercel's Node `(req, res)` signature.
  - `auth.ts` — **session guard**: resolves `Authorization: Bearer <token>`
    against the `sessions` table and returns the user.
  - `authService.ts` — register / login / logout / authenticate. Passwords are
    scrypt-hashed (`password.ts`); sessions store only the SHA-256 of the token
    (`sessions.ts`).
  - `rateLimit.ts` — sliding-window rate limiter (auth + API scopes; fails
    safe: invalid env config falls back to sane defaults).
  - `providers.ts` — server-side provider layer / Model Router
    (`createServerRouter`): NVIDIA NIM primary → Groq fallback, built per
    request. Provider keys (`NVIDIA_API_KEY`, `GROQ_API_KEY`) never leave the
    server; failures are classified (`authentication` / `rate_limit` /
    `timeout` / `unavailable_model` / `malformed_response` / `network`) and
    returned to clients as secret-safe messages.
  - `middleware.ts` — `withHttp`: CORS + preflight, secret-safe 500s and
    request logging, applied on Vercel (`api/*.ts`) and locally (`router.ts`).
  - `beta.ts` — closed-beta gate (`ZEESH_BETA_MODE` / `ZEESH_BETA_ALLOWLIST`).
  - `log.ts` — safe request logging (secrets scrubbed before output).
  - `db.ts` — Neon PostgreSQL client (`DATABASE_URL`), created lazily.
  - `usage.ts` — usage-recording service (`agent_runs` + `usage` rows).
  - `freeSessions.ts` — GRACE FREE daily session service (6 sessions/day × 60
    min, server-enforced; `free_sessions` table, migration `004_free_sessions.sql`).
  - `router.ts` + `server.ts` — local dev server over `node:http`.
- `api/*.ts` and `api/auth/*.ts` — thin Vercel zero-config serverless functions
  exporting the same handlers.

## Endpoints

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| GET | `/api/health` | none | Liveness + configuration probe |
| POST | `/api/auth/register` | none (rate-limited) | Create account → session token (`403` when the closed beta gate is on and the email is not allowlisted) |
| POST | `/api/auth/login` | none (rate-limited) | Verify credentials → session token |
| POST | `/api/auth/logout` | Session | Invalidate the session |
| GET | `/api/auth/me` | Session | Current user (whoami) |
| POST | `/api/usage` | Session | Record one agent run + token usage |
| GET | `/api/usage?limit=…` | Session | Recent usage rows **+ the daily free-session state** for the authenticated user |
| POST | `/api/provider` | Session | Proxy a chat completion (provider key stays server-side; gated by the free-session quota) |

### GET /api/health

```json
{
  "status": "ok",
  "service": "zeesh-api",
  "version": "0.1.0",
  "time": "2026-08-09T12:00:00.000Z",
  "database": "not_configured | connected | error",
  "auth": "configured | not_configured"
}
```

### POST /api/auth/register

```json
{ "email": "dev@example.com", "password": "hunter2-strong", "display_name": "Dev" }
```

`201` → `{ "user": { "id": "…", "email": "…", "display_name": "Dev" }, "token": "…", "expires_at": "2026-09-08T…" }`.

- Password must be ≥ 8 characters; hashed with scrypt, never stored in
  plaintext.
- `409` when the email is already registered, `400` on validation failure.
- `403` when `ZEESH_BETA_MODE=closed` and the email is not in
  `ZEESH_BETA_ALLOWLIST` (closed beta gate, Milestone 12).

### POST /api/auth/login

```json
{ "email": "dev@example.com", "password": "hunter2-strong" }
```

`200` → same shape as register. `401` on bad credentials.

### POST /api/auth/logout

`Authorization: Bearer <token>` → `200 { "logged_out": true }`.

### GET /api/auth/me

`Authorization: Bearer <token>` → `200 { "user": { "id", "email", "display_name" } }`.

### POST /api/usage

`user_id` in the body is **ignored** — the session is the source of truth, so a
caller can never record usage as someone else. All token/turn fields are
non-negative integers:

```json
{
  "client_run_id": "cli-generated-uuid",
  "session_id": null,
  "project_type": "node",
  "prompt": "Fix the login bug",
  "status": "done",
  "model": "openai/gpt-oss-120b",
  "agent_turns": 4,
  "tool_calls": 12,
  "input_tokens": 4520,
  "output_tokens": 890,
  "execution_time_ms": 31240
}
```

`201` → `{ "recorded": true, "run_id": 123 }`. Validation failures → `400`.
Re-sending the same `client_run_id` is idempotent (reuses the run, no double
usage row).

### GET /api/usage

`Authorization: Bearer <token>` → `200` with the authenticated user's recent
rows (`?limit=`, default 20, max 100) **plus the GRACE FREE daily session
state** (Milestone 13):

```json
{
  "usage": [ { "id": 1, "model": "openai/gpt-oss-120b", "input_tokens": 4520, "output_tokens": 890, "created_at": "…" } ],
  "sessionsUsed": 2,
  "sessionsRemaining": 4,
  "currentSession": 2,
  "sessionStartedAt": "2026-08-10T09:00:00.000Z",
  "sessionExpiresAt": "2026-08-10T10:00:00.000Z",
  "dailyUsedSeconds": 5400,
  "dailyLimitSeconds": 21600
}
```

This endpoint is **read-only** — it never starts or consumes a session (only
inference requests do). The server is the single source of truth for the
quota: the CLI stores nothing locally, so restarting it or deleting local
files can never reset the limit.

### POST /api/provider

```json
{
  "messages": [{ "role": "user", "content": "Hello" }],
  "model": "openai/gpt-oss-120b",
  "temperature": 0.2
}
```

`200` → `{ "content": "…", "tool_calls": [], "usage": {…}, "finish_reason": "stop", "provider_id": "nvidia", "provider_label": "NVIDIA NIM", "session": { … } }`.

The response also reports which provider **actually served** the request
(`provider_id` / `provider_label`, after router fallback) so the CLI can show
`Provider: NVIDIA NIM` without ever seeing a key.

**Provider failures** are classified and mapped to safe responses:

| Failure | Response |
| ------- | -------- |
| authentication (bad server-side key) | `502` — "rejected the server-side API key" |
| rate limit | `429` — wait and retry |
| timeout | `504` — retry |
| unavailable model | `502` — pick a different model |
| malformed response / network / other | `502` — generic retry hint |

Error text is server-authored and never contains a provider key; raw provider
detail is scrubbed (`nvapi-…`, `sk-…`, `gsk_…`) before it reaches logs.

**Free-plan gate (Milestone 13):** before any model call, the server runs the
daily session gate (`src/api/freeSessions.ts`):

- No active session + quota remains → a session is **auto-started** (the
  response's `session.startedNew` is `true`, telling the CLI a rollover
  happened).
- Active session → the request runs inside it (`startedNew: false`).
- All 6 sessions for the day used → `429` with
  `{ "error": "…", "code": "daily_limit_exhausted" }` and a `Retry-After`
  header pointing at the next UTC day. No provider call is made.

The response embeds the same state as `GET /api/usage` (`sessionsUsed`,
`sessionsRemaining`, `currentSession`, `sessionStartedAt`, `sessionExpiresAt`,
`dailyUsedSeconds`, `dailyLimitSeconds`) plus `startedNew`.

## Authentication model

- The client (`grace login`) sends email + password over HTTPS; the server
  verifies the scrypt hash and returns an opaque session token.
- The CLI stores the token locally (`~/.zeesh/auth.json`, mode 0600) and
  sends it as `Authorization: Bearer <token>`. The raw token is never stored
  server-side — only `SHA-256(token)` in `sessions.token_hash`.
- Sessions expire after 30 days (`sessions.expires_at`); expired/invalid tokens
  get `401`.

## Free plan — daily sessions (Milestone 13)

GRACE FREE quotas are **backend-authoritative**. See the
[Free plan section in the README](../README.md#free-plan--daily-sessions-milestone-13-grace-free)
for the product rules; the API surface is:

- `free_sessions` rows (Neon, `004_free_sessions.sql`): `user_id`, UTC `day`,
  `session_number`, `started_at`, `expires_at`, `ended_at`, with a
  `UNIQUE (user_id, day, session_number)` constraint that makes concurrent
  session starts race-safe (the loser retries with the new `MAX`).
- Sessions belong to the UTC day they started in; the day boundary is
  **00:00 UTC** for every user.
- Expiry is detected lazily on each request — no background job needed.
- A day's `dailyUsedSeconds` sums each session's elapsed time, capped at its
  own 60-minute length and at the 6-hour daily cap.

## Rate limiting

Sliding-window, per client IP (in-memory; a shared store is a Milestone 12+
concern once multiple serverless instances exist):

| Scope | Limit | Where |
| ----- | ----- | ----- |
| auth | 50 attempts / 15 min (login+register) | `ZEESH_AUTH_RATE_LIMIT_MAX` |
| api | 300 requests / 1 min (usage, provider) | `ZEESH_API_RATE_LIMIT_MAX` |

`429` responses include a `Retry-After` header; the CLI surfaces the wait in
its error message (`Too many attempts — try again in Ns`). The limiter is
per-process and fails safe (invalid env config falls back to defaults); the
CLI's usage reporter treats any failure as non-fatal and never interrupts the
local agent. A shared store (Redis/Upstash) is recommended before public beta
(M15).

## Environment variables

| Variable | Where | Purpose |
| -------- | ----- | ------- |
| `GROQ_API_KEY` | CLI + API | Local agent key; also the server-side **fallback** provider for `/api/provider` |
| `NVIDIA_API_KEY` | API only | Server-side **primary** provider (NVIDIA NIM) for `/api/provider` — never sent to the CLI |
| `DATABASE_URL` | API only | Neon PostgreSQL connection string (required for auth + usage) |
| `ZEESH_API_URL` | CLI only | Backend URL the CLI logs in to (default `http://localhost:8787`; set to your deployed URL in production) |
| `ZEESH_BETA_MODE` | API only | `closed` gates registration behind the allowlist (default `open`) |
| `ZEESH_BETA_ALLOWLIST` | API only | Comma-separated emails allowed to register when closed |
| `ZEESH_CORS_ORIGIN` | API only | Browser origin allowed to call the API (default `*`) |
| `ZEESH_AUTH_RATE_LIMIT_MAX` | API only | Auth rate-limit budget (default 50/15 min) |
| `ZEESH_API_RATE_LIMIT_MAX` | API only | API rate-limit budget (default 300/min) |
| `ZEESH_SESSIONS_PER_DAY` | API only | Free-plan sessions per user per day (default 6) |
| `ZEESH_SESSION_DURATION_MINUTES` | API only | Free-plan session length (default 60) |

Placeholders in [`.env.example`](../.env.example). `.env` and other secret
files are git-ignored.

## Run locally

```bash
npm run serve                 # http://localhost:8787 (loads .env from the project root)
curl http://localhost:8787/api/health

# from another terminal — register, then use the returned token:
curl -X POST -H "Content-Type: application/json" \
     -d '{"email":"dev@example.com","password":"hunter2-strong"}' \
     http://localhost:8787/api/auth/register

# or let the CLI do it (prompts for email/password, hides the password):
grace login
grace whoami
```

The CLI reports usage automatically after each agent run while logged in.
Override the port with `PORT=9999 npm run serve`.

## Deploy to Vercel

`api/*.ts` are zero-config Node serverless functions — `vercel` picks them up
automatically. `vercel.json` sets the max duration (60s); the Node.js runtime
is auto-detected by Vercel. Full instructions, env vars, migration and
rollback steps are in **`docs/deployment.md`**.

Notes:

- Vercel bundles each `api/*.ts` entrypoint with esbuild; relative imports use
  explicit `.ts` extensions, which esbuild resolves.
- The CLI's `dist/` is irrelevant to Vercel — only `api/`, `src/` and
  `package.json` are needed.
- Do **not** put `GROQ_API_KEY` or `NVIDIA_API_KEY` in any client-facing
  environment.
- Every function exports `withHttp(handler)`, so CORS, preflight, safe errors
  and request logging behave identically to the local dev server.
- The in-memory rate limiter resets per cold start; move to Redis/Upstash
  before public beta (Milestone 15).

## Security notes (current state)

- Provider keys (`NVIDIA_API_KEY`, `GROQ_API_KEY`) and `DATABASE_URL` are
  server-side only and never reach the CLI or browser.
- Passwords are scrypt-hashed with a per-user salt; plaintext is never stored,
  logged, or returned.
- Sessions store only the SHA-256 hash of the token; tokens expire after 30
  days and logout invalidates them server-side.
- Protected endpoints (`/api/usage`, `/api/provider`, `/api/auth/me|logout`)
  require a valid session and scope data to the authenticated user — the old
  shared `ZEESH_API_TOKEN` (Milestone 10) has been removed.
- Auth endpoints are rate-limited per IP; the API client times out and degrades
  gracefully when the backend is unavailable.
- Errors never leak internals: unexpected failures return a generic `500`
  (details go to the server log only), provider failures return a generic
  message, and all responses carry CORS headers with `OPTIONS` preflight.

## Observability (Milestone 12)

Every request is logged server-side in a single scrub-safe line
(`[api] method=… path=… status=… latency_ms=… [user_id=…] [model=…]`), plus
extra facts where valuable (usage: model/tokens/run_id; provider failures: the
sanitized reason). **Never logged:** passwords, session tokens, API keys,
`DATABASE_URL`, request bodies, private project files. All free-text fields
pass through `scrubForLogs()` before output (`src/api/log.ts`).
