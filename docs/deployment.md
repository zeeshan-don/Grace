# Deployment (Python backend on Vercel + Neon)

This document explains how to deploy the **Python** GRACE backend to **Vercel**
with a **Neon PostgreSQL** database. It contains **no real secrets** — only
placeholders and instructions.

```
LOCAL CLI  →  GRACE API (Vercel, Python)  →  Neon PostgreSQL  →  Model Router → Groq → NVIDIA NIM → Gemini → MiniMax
```

The backend is implemented in `grace/server/` (a WSGI app) and shipped as
zero-config Python functions in `api/*.py`. The same handlers run locally via
`python -m grace.server.serve`, so behavior is identical locally and in
production.

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
2. From the repo root, run `npx vercel build` first — the log should show
   **"Detected Python functions in api/"** and install the dependencies.
   `requirements.txt` (requests, psycopg) is the dependency source Vercel
   honors across every builder generation; `pyproject.toml` is used by the
   CLI locally (including textual). If `/api/health` returns Vercel's
   platform-level `FUNCTION_INVOCATION_FAILED` 500 after a deploy, the
   functions crashed while importing. The two known causes:
   - **Missing dependencies** — redeploy with `requirements.txt` present.
   - **Entrypoint bootstrap** — Vercel loads each `api/*.py` from its file
     path with only the repo root (and site-packages) on `sys.path`, so the
     old `import _boot` (the module lives inside `api/`) could not resolve
     and every endpoint died at invocation. The entrypoints now add `api/`
     and the repo root to `sys.path` themselves — do **not** reintroduce
     `import _boot` in an entrypoint.
3. `vercel link` (create a new project, e.g. `grace-python-staging` for the
   staging deployment). `vercel.json` sets a 60s max duration for the Python
   functions.

The API lives in `api/**/*.py` (zero-config Python serverless functions). Each
file maps to its route (`api/health.py` → `/api/health`,
`api/auth/login.py` → `/api/auth/login`, …) and serves the shared WSGI app
from `grace/server/`. There is **no** TypeScript backend in the repository —
`src/` was removed after the Python migration was verified.

> **GRACE ships a static website (`public/`) alongside the Python API (`api/`).**
> `vercel.json` declares the `api/**/*.py` serverless functions and contains
> **no** `framework` preset and **no `outputDirectory`**. With no framework
> detected, Vercel serves `public/` as the zero-config static output **and**
> registers each `api/*.py` file as a file-based Python function.
>
> **Why the root route 404'd:** the repository previously had API functions but
> no static content, so `/` had nothing to serve and returned Vercel's
> platform-level **`NOT_FOUND`** 404 page. Adding the `public/` directory (the
> zero-config static directory) fixed the root route without touching the API.
>
> **Never set an `outputDirectory` in `vercel.json`** — `"outputDirectory": ""`
> tells Vercel the repo root is static output; the deployment goes into
> static-file mode, the serverless routes are never registered, and every
> request returns Vercel's platform-level **`NOT_FOUND`** 404 page.
>
> **Vercel dashboard Project Settings take precedence over `vercel.json`.**
> Leave the **Output Directory** field empty (Project → Settings → Build &
> Development Settings → Save) so Vercel keeps its zero-config defaults:
> static files from `public/` **and** Python functions from `api/`. Do **not**
> point Output Directory at `public/` alone — that drops the serverless routes.

## 2. Neon setup

1. Create a project at <https://console.neon.tech>.
2. Copy the **pooled** connection string (Project → Connection Details).
3. Apply the migrations (see §4).

## 3. Required environment variables

Set these in the **Vercel dashboard** (Project → Settings → Environment
Variables) for the `production` (and `preview`) environments:

| Variable | Required | Purpose |
| -------- | -------- | ------- |
| `DATABASE_URL` | yes | Neon pooled connection string (`postgresql://…`) — read by `grace/server/db.py` (psycopg 3) |
| `GROQ_API_KEY` | yes | Server-side AI key for `/api/provider` (primary provider) — never exposed to clients |
| `NVIDIA_API_KEY` | no* | Server-side provider (NVIDIA NIM) for `/api/provider` — never exposed to clients. Adds a fallback leg after Groq |
| `GEMINI_API_KEY` | no* | Server-side fallback provider (Gemini, `gemini-3.1-flash-lite`) — never exposed to clients |
| `MINIMAX_API_KEY` | no* | Server-side fallback provider (MiniMax-M3, last in the chain) — never exposed to clients |
| `ZEESH_BETA_MODE` | no | `closed` to gate registration behind an allowlist (default `open`) |
| `ZEESH_BETA_ALLOWLIST` | no | Comma-separated emails allowed to register when closed |
| `ZEESH_CORS_ORIGIN` | no | Browser origin allowed to call the API (default `*`) |
| `ZEESH_AUTH_RATE_LIMIT_MAX` | no | Auth attempts / 15 min per IP (default 50) |
| `ZEESH_API_RATE_LIMIT_MAX` | no | API requests / min per IP (default 300) |
| `ZEESH_DAILY_COST_LIMIT_INR` | no | Per-user daily cost ceiling, default ₹20 (`grace/server/cost_guard.py`) |
| `ZEESH_INR_PER_USD` | no | INR→USD rate for the cost ceiling (default 83) |
| `ZEESH_GLOBAL_DAILY_COST_LIMIT_INR` / `ZEESH_GLOBAL_MONTHLY_COST_LIMIT_INR` | no | Global circuit breakers (0 = disabled) |

**Never** put client-side secrets here — the CLI must only ever receive its own
session token.

### CLI-side configuration (each tester)

The CLI reads `ZEESH_API_URL` to know which backend to log in to. It defaults
to the deployed production backend, so no configuration is needed to use
production:

```bash
grace login   # → "GRACE backend: https://grace.zeeshstudios.in"
```

Set `ZEESH_API_URL` **only** to opt into local development against the Python
dev server:

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

## 5. Staging + production deployment

```bash
npx vercel build          # verify the Python function build locally
npx vercel deploy --prebuilt   # staging/preview deployment
npx vercel --prod         # promote to production once staging is verified
```

First deploy: add the environment variables **before** deploying (env vars
apply per deploy).

## 6. Verification commands

```bash
# 0. Website (static site in public/) — the root route must not 404
curl -I https://<your-project>.vercel.app/
#    → 200 text/html — the GRACE landing page
curl -I https://<your-project>.vercel.app/assets/site.css
#    → 200 text/css — static assets resolve

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

# 5. CLI against the deployed backend
export ZEESH_API_URL=https://<your-project>.vercel.app
grace login
grace whoami
grace logout
```

## 7. Local development

```bash
pip install -e ".[dev]"          # install the CLI + backend + pytest
python -m pytest                 # full test suite (166 tests incl. backend)
python -m grace.server.serve     # local backend at http://localhost:8787
curl http://localhost:8787/api/health
```

`PORT` overrides the dev-server port: `PORT=9999 python -m grace.server.serve`.

## 9. Website — static site in `public/`

The official GRACE website is a dependency-free static site in `public/`
(`index.html`, `assets/site.css`, `assets/site.js`, `assets/grace-logo.png`,
plus favicons). Vercel serves it from the same deployment as the API:

- `/` → `public/index.html` (no framework, no build step, no runtime deps)
- `/assets/*` → static assets
- `/api/*` → the Python functions

Run it locally with any static server:

```bash
python -m http.server 8000 --directory public   # http://localhost:8000
```

The site has no build step and no dependencies — edit the files in `public/`
and commit. The `functions` block in `vercel.json` excludes `public/**` so
static assets never bloat the serverless bundles.

- **Schema**: migrations are additive + idempotent. There is no destructive
  `DROP`/`ALTER … DROP COLUMN`; rolling back a migration means simply not
  applying the next one. To revert a bad deploy, redeploy the previous commit.
- **Data**: no migration deletes or rewrites existing rows. `users.is_beta`
  defaults to `false`; existing accounts are never locked out by the closed
  beta gate (the gate only affects new registrations).
- **Passwords**: `grace/server/password.py` produces Node-scrypt-compatible
  hashes, so accounts created by the TypeScript backend verify unchanged.
- **Secrets**: if you ever suspect a key leaked, rotate it in Neon/Vercel and
  redeploy. The CLI stores only a session token (mode 0600) and the server
  stores only hashes.
- **Rate limiting** is in-memory (per instance). For public beta (M15+) move
  it to a shared store (e.g. Upstash Redis) so limits survive cold starts.
- **Free-plan sessions** are enforced in Neon (`free_sessions`, migration
  004) and are safe across cold starts by design — the quota is server-side
  state, never per-instance memory.
