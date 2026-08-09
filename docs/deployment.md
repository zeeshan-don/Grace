# Deployment (Milestone 12 — closed beta)

This document explains how to deploy the ZEESH AI backend to **Vercel** with a
**Neon PostgreSQL** database. It contains **no real secrets** — only
placeholders and instructions.

```
LOCAL CLI  →  ZEESH AI API (Vercel)  →  Neon PostgreSQL  →  AI providers (server-side key)
```

The local CLI itself is not deployed: it runs on the developer's machine and
talks to this backend only for accounts + usage reporting (`myagent login`).

---

## 1. Vercel setup

1. Install the CLI: `npm i -g vercel`
2. From the repo root, run `vercel` and follow the prompts (create a new
   project, e.g. `zeesh-ai`). `vercel.json` pins the functions to the
   Node 22 runtime with a 60s max duration.
3. Link the project for future deploys: `vercel link`

The API lives in `api/**/*.ts` (zero-config serverless functions). They bundle
`src/` with esbuild, so the built `dist/` is **not** part of the deployment.

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
| `GROQ_API_KEY` | yes | Server-side AI key for `/api/provider` — never exposed to clients |
| `ZEESH_BETA_MODE` | no | `closed` to gate registration behind an allowlist (default `open`) |
| `ZEESH_BETA_ALLOWLIST` | no | Comma-separated emails allowed to register when closed |
| `ZEESH_CORS_ORIGIN` | no | Browser origin allowed to call the API (default `*`) |
| `ZEESH_AUTH_RATE_LIMIT_MAX` | no | Auth attempts / 15 min per IP (default 50) |
| `ZEESH_API_RATE_LIMIT_MAX` | no | API requests / min per IP (default 300) |

**Never** put client-side secrets here — the CLI must only ever receive its own
session token.

### CLI-side configuration (each tester)

The CLI reads `ZEESH_API_URL` to know which backend to log in to. In production
every tester should point it at the deployed backend:

```bash
# per machine, in ~/.myagent/env
ZEESH_API_URL=https://zeesh-ai.vercel.app
```

If unset, the CLI defaults to `http://localhost:8787` (local dev only).

## 4. Database migration

Apply migrations in order to Neon (either via `psql` or the Neon SQL Editor).
All migrations are idempotent and safe to re-run; they never delete data:

```bash
psql "$DATABASE_URL" -f db/migrations/001_init.sql
psql "$DATABASE_URL" -f db/migrations/002_auth.sql
psql "$DATABASE_URL" -f db/migrations/003_closed_beta.sql
```

Verify:

```sql
SELECT version();
SELECT COUNT(*) FROM users;          -- existing data untouched
SELECT indexname FROM pg_indexes WHERE tablename IN ('users','sessions','agent_runs','usage');
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
myagent login
myagent whoami
myagent logout
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
- **Rate limiting** is in-memory (per instance). For public beta (M13+) move
  it to a shared store (e.g. Upstash Redis) so limits survive cold starts.

## Runtime notes

- `package.json` `engines: ">=23.6.0"` applies to the **CLI** (it runs
  TypeScript directly via native type stripping). The Vercel functions are
  esbuild-bundled and pinned to `nodejs22.x` (`vercel.json`) — they only use
  Node 18+ features (`fetch`, `AbortSignal.timeout`), so the runtime mismatch
  is expected and safe.
- The middleware (`withHttp`) reassigns `res.status` to capture response
  codes for logging — verified locally in tests and by `npm run smoke`; after
  the first production deploy, sanity-check one response with
  `curl -i <prod>/api/health` (headers + status + JSON body).
