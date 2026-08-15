# Deployment (Milestone 12 — closed beta)

This document explains how to deploy the GRACE backend to **Vercel** with a
**Neon PostgreSQL** database. It contains **no real secrets** — only
placeholders and instructions.

```
LOCAL CLI  →  GRACE API (Vercel)  →  Neon PostgreSQL  →  Model Router → Groq → NVIDIA NIM → Gemini → MiniMax
```

*With only `GROQ_API_KEY` set (required), `/api/provider` works exactly as
before. Each additional key adds a fallback leg to the same request: NVIDIA
NIM, then Gemini, then MiniMax (order overridable via `ZEESH_SERVER_ROUTING`).
The chain only ever moves to the next provider on a provider-level failure,
never after a partial response.*

The local CLI itself is not deployed: it runs on the developer's machine and
talks to this backend only for accounts + usage reporting (`grace login`).

---

## 1. Vercel setup

1. Install the CLI: `npm i -g vercel`
2. From the repo root, run `vercel` and follow the prompts (create a new
   project, e.g. `zeesh-ai`). `vercel.json` sets a 60s max duration; the
   Node.js runtime is auto-detected for the zero-config `api/*.ts` functions.
3. Link the project for future deploys: `vercel link`

The API lives in `api/**/*.ts` (zero-config serverless functions). They bundle
`src/` with esbuild, so the built `dist/` is **not** part of the deployment.

> **GRACE is not a static site.** `vercel.json` declares the `api/**/*.ts`
> serverless functions, contains **no** `framework` preset (Vercel auto-detects
> "Other"), and **omits `outputDirectory` entirely** — this is the correct,
> current config format (the legacy `builds` array in `vercel.json` is
> deprecated).
>
> **Never set an `outputDirectory` for an API-only project** — and in
> particular never set it to `""` (empty string). `"outputDirectory": ""`
> tells Vercel the repo root is static output; the deployment goes into
> static-file mode, the zero-config serverless routes are never registered,
> and every request (e.g. `GET /api/health`) returns Vercel's platform-level
> **`NOT_FOUND`** 404 page (<https://vercel.com/docs/errors/not_found.md>)
> instead of reaching your handlers. The correct `vercel.json` has **no**
> `outputDirectory` key at all.
>
> **However, Vercel dashboard Project Settings take precedence over
> `vercel.json`.** When the project is created with no framework detected
> (the "Other" preset), Vercel stores `Output Directory: public` in the
> project settings. Because that stored setting wins over the absent
> `outputDirectory` in `vercel.json`, every build fails with
> *"No Output Directory named 'public' found"* — `vercel.json` **cannot**
> override it.
>
> **Fix (one time, in the dashboard):** Project → **Settings → Build &
> Development Settings** → clear the **Output Directory** field → **Save**,
> then redeploy. Do **not** create a `public/` folder, and do not set an
> Output Directory for an API-only project. If the project is not created
> yet, when the CLI proposes `Output Directory: public`, decline/override it
> and leave the field empty. If instead you hit the `NOT_FOUND` page above,
> the fix is the same: ensure `vercel.json` has no `outputDirectory` key,
> clear the dashboard field, and redeploy with `vercel --prod`.

## 2. Neon setup

1. Create a project at <https://console.neon.tech>.
2. Copy the **pooled** connection string (Project → Connection Details).
3. Apply the migrations (see §4).

## 3. Required environment variables

Set these in the **Vercel dashboard** (Project → Settings → Environment
Variables) for the `production` (and `preview`) environments:

| Variable | Required | Purpose |
| -------- | -------- | ------- |
| `DATABASE_URL` | yes | Neon pooled connection string (`postgresql://…`) |
| `GROQ_API_KEY` | yes | Server-side AI key for `/api/provider` (primary provider) — never exposed to clients |
| `NVIDIA_API_KEY` | no* | Server-side provider (NVIDIA NIM) for `/api/provider` — never exposed to clients. Adds a fallback leg after Groq |
| `GEMINI_API_KEY` | no* | Server-side fallback provider (Gemini, `gemini-3.1-flash-lite`) — never exposed to clients |
| `MINIMAX_API_KEY` | no* | Server-side fallback provider (MiniMax-M3, last in the chain) — never exposed to clients |
| `ZEESH_BETA_MODE` | no | `closed` to gate registration behind an allowlist (default `open`) |
| `ZEESH_BETA_ALLOWLIST` | no | Comma-separated emails allowed to register when closed |
| `ZEESH_CORS_ORIGIN` | no | Browser origin allowed to call the API (default `*`) |
| `ZEESH_AUTH_RATE_LIMIT_MAX` | no | Auth attempts / 15 min per IP (default 50) |
| `ZEESH_API_RATE_LIMIT_MAX` | no | API requests / min per IP (default 300) |

**Never** put client-side secrets here — the CLI must only ever receive its own
session token.

### CLI-side configuration (each tester)

The CLI reads `ZEESH_API_URL` to know which backend to log in to. **It now
defaults to the deployed production backend** (`https://zeesh-ai.vercel.app`),
so no configuration is needed to use production:

```bash
grace login   # → "GRACE backend: https://zeesh-ai.vercel.app"
```

Set `ZEESH_API_URL` **only** to opt into local development against
`npm run serve`:

```bash
# per machine, in ~/.zeesh/env (or project .env)
ZEESH_API_URL=http://localhost:8787   # local dev only
```

## 4. Database migration

Apply migrations in order to Neon (either via `psql` or the Neon SQL Editor).
All migrations are idempotent and safe to re-run; they never delete data:

```bash
psql "$DATABASE_URL" -f db/migrations/001_init.sql
psql "$DATABASE_URL" -f db/migrations/002_auth.sql
psql "$DATABASE_URL" -f db/migrations/003_closed_beta.sql
psql "$DATABASE_URL" -f db/migrations/004_free_sessions.sql
psql "$DATABASE_URL" -f db/migrations/005_cost_guard.sql
```

Verify:

```sql
SELECT version();
SELECT COUNT(*) FROM users;          -- existing data untouched
SELECT indexname FROM pg_indexes WHERE tablename IN ('users','sessions','agent_runs','usage','free_sessions');
```

## 5. Production deployment

```bash
vercel --prod          # deploy the linked project
```

First deploy: add the environment variables **before** running `vercel --prod`
(or redeploy after adding them — env vars apply per deploy).

## 6. Verification commands

```bash
# 1. Health (public)
curl https://<your-project>.vercel.app/api/health
#    → {"status":"ok",...,"database":"connected","auth":"configured"}

# 2. Register (closed beta: use an allowlisted email)
curl -X POST -H "Content-Type: application/json" \
  -d '{"email":"beta@example.com","password":"hunter2-strong"}' \
  https://<your-project>.vercel.app/api/auth/register

# 3. Login → token
curl -X POST -H "Content-Type: application/json" \
  -d '{"email":"beta@example.com","password":"hunter2-strong"}' \
  https://<your-project>.vercel.app/api/auth/login

# 4. Whoami with the token
curl -H "Authorization: Bearer <token>" https://<your-project>.vercel.app/api/auth/me

# 5. CLI against production
export ZEESH_API_URL=https://<your-project>.vercel.app
grace login
grace whoami
grace logout
```

## 7. Rollback considerations

- **Schema**: migrations are additive + idempotent. There is no destructive
  `DROP`/`ALTER … DROP COLUMN`; rolling back a migration means simply not
  applying the next one. To revert a bad deploy, redeploy the previous
  commit (`vercel --prod` again).
- **Data**: no migration deletes or rewrites existing rows. `users.is_beta`
  defaults to `false`; existing accounts are never locked out by the closed
  beta gate (the gate only affects new registrations).
- **Secrets**: if you ever suspect a key leaked, rotate it in Neon/Vercel and
  redeploy. The CLI stores only a session token (mode 0600) and the server
  stores only hashes.
- **Rate limiting** is in-memory (per instance). For public beta (M15+) move
  it to a shared store (e.g. Upstash Redis) so limits survive cold starts.
- **Free-plan sessions** are enforced in Neon (`free_sessions`, migration
  004) and are safe across cold starts by design — the quota is server-side
  state, never per-instance memory.

## Runtime notes

- `package.json` `engines: ">=23.6.0"` applies to the **CLI** (it runs
  TypeScript directly via native type stripping). The Vercel functions are
  esbuild-bundled and run on Vercel's default Node.js runtime — they only use
  Node 18+ features (`fetch`, `AbortSignal.timeout`), so the difference from
  the CLI's Node version is expected and safe.
- The middleware (`withHttp`) reassigns `res.status` to capture response
  codes for logging — verified locally in tests and by `npm run smoke`; after
  the first production deploy, sanity-check one response with
  `curl -i <prod>/api/health` (headers + status + JSON body).
