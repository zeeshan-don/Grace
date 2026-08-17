# Architecture

This document describes Grace's architecture as it exists in the repository
today. It is a map for contributors — every component listed here is real
code you can open. For where to look when changing specific behavior, see
[development.md](development.md).

## Overview

```
┌───────────────────────────────────────────────────────────────────────┐
│                         GRACE CLI (Python)                            │
│  grace/cli/         entry point, REPL, one-shot runner, slash cmds   │
│  grace/cli/tui/     full-screen Textual TUI (app, store, runner)     │
│  grace/cli/ui/      classic `grace>` prompt rendering                 │
└─────────────────────────────────┬─────────────────────────────────────┘
                                  │  task · tool calls · usage reporting
                                  ▼
┌───────────────────────────────────────────────────────────────────────┐
│                          AGENT LAYER                                  │
│  grace/agent/       reason → act → observe loop, context management   │
│  grace/agents/      coordinator · planner · fast router · model       │
│                     router · subagents · capabilities · test runner   │
└───────────────┬──────────────────────────────┬────────────────────────┘
                │                              │
                ▼                              ▼
┌───────────────────────────┐   ┌───────────────────────────────────────┐
│  TOOLS  (grace/tools/)    │   │  PROVIDERS  (grace/providers/)        │
│  read_file · write_file   │   │  AIProvider contract · Groq · NVIDIA  │
│  edit_file · search_files │   │  NIM · Gemini · MiniMax · DeepSeek    │
│  list_directory ·         │   │  fallback chain · failure taxonomy    │
│  run_command · git_diff   │   │  pricing (grace/costs/)               │
│  web_fetch                │   └────────────────────┬──────────────────┘
│  gated by grace/safety.py │                        │  model calls
└───────────────────────────┘                        │
                                                     ▼
┌───────────────────────────────────────────────────────────────────────┐
│                      PYTHON BACKEND (grace/server)                    │
│  WSGI app (serve.py · wsgi.py) · handlers · middleware (CORS, safe    │
│  errors, scrub-safe logging) · auth · sessions · free_sessions ·      │
│  cost_guard · rate_limit · server-side providers                      │
└───────────────┬──────────────────────────────┬────────────────────────┘
                │                              │
                ▼                              ▼
┌───────────────────────────┐   ┌───────────────────────────────────────┐
│  NEON POSTGRESQL          │   │  AI PROVIDERS (server-side keys)      │
│  db/migrations/*.sql      │   │  same Groq → NVIDIA → Gemini →        │
│  users · sessions · usage │   │  MiniMax chain, built per request     │
│  free_sessions · ai_usage │   └───────────────────────────────────────┘
└───────────────────────────┘

  Vercel functions (api/) — health, auth/*, usage, provider — import and
  serve the same handlers as grace/server in production.
```

## Components

### CLI (`grace/cli/`)

The entry point (`grace/cli/index.py`) parses flags (`--model`, `--yes`,
`--new-window`, `--verbose`, `--version`), dispatches subcommands
(`login`, `register`, `logout`, `whoami`), and otherwise starts either the
interactive REPL (`repl.py`) or a one-shot run (`once.py`). Slash commands
(`/help`, `/status`, `/model`, `/diff`, `/undo`, …) live in `commands.py`,
auth commands in `auth_commands.py`, and free-tier display helpers in
`free_plan.py`. The full-screen TUI (`cli/tui/`) is a Textual app driven by a
store and a runner; `cli/ui/` renders the classic prompt when there is no TTY.

### Agent loop (`grace/agent/`)

The core loop is reason → act → observe: the agent receives the task and
repository context, chooses a tool, observes the result, and iterates until
done or it needs approval. Context management estimates token usage, trims
old tool results, and truncates oversized output. Session history persists in
`.zeesh/session.json`; every file the agent modifies is snapshotted in
`.zeesh/undo/` for `/undo`.

### Coordinator / router (`grace/agents/`)

Grace is built around **one primary agent** by default. A deterministic fast
router (`fast_router.py`) classifies requests without any model call:
greetings and simple conversation are answered locally, `run the tests` goes
to the deterministic test runner, and everything else starts the primary
agent. Complex tasks may trigger an optional planning phase
(`planner.py`), and specialized subagents (`subagent.py`, `specs.py`) run
only when a plan includes them. The model router (`model_router.py`) maps
`(role, tier)` to `(provider, model)`; `role_router.py` handles role-based
routing, `capabilities.py` what agents can do, and `structured.py` /
`compact.py` the structured/compact protocol between agents.

### Tools (`grace/tools/`)

The agent's capabilities: `read_file`, `write_file`, `edit_file`,
`search_files`, `list_directory`, `run_command`, `git_diff`, and
`web_fetch`, registered in `registry.py`. Tool definitions and the
`call_tool` dispatch live in `tool.py`. All of them sit behind the safety
policy in `grace/safety.py`: a command deny list (`rm -rf`, `sudo`,
`git push`/`reset --hard`, database drops, infra mutations, …), protected
files (`.env*`, `*.pem`, `*.key`, credentials), and secret redaction of
`sk-…`/`gsk_…`-shaped values from output.

### Providers (`grace/providers/`)

All providers implement the `AIProvider` contract (`types.py`) and are
registered in `registry.py`: Groq, NVIDIA NIM, Gemini, MiniMax, and DeepSeek.
`fallback.py` retries a request on the next provider only for
provider-level failures (rate limit, quota, timeout, outage, network) —
**before** any response is consumed — so a fallback can never duplicate a
tool execution. `errors.py` classifies failures
(`authentication` / `rate_limit` / `timeout` / `unavailable_model` /
`malformed_response` / `network`) and surfaces secret-safe messages. The
remote provider (`remote.py`) is how the CLI calls the hosted router when
logged in.

### Backend (`grace/server/`)

A plain WSGI application: `serve.py` (local dev server on
`http://localhost:8787`), `wsgi.py` (the shared router), `handlers.py`
(endpoints), and `middleware.py` — every request goes through CORS +
`OPTIONS` preflight, secret-safe error responses, and one scrub-safe log
line. `db.py` connects lazily to Neon via `DATABASE_URL` (psycopg 3), so the
API boots without a database. `providers.py` builds the server-side model
chain from server-only keys.

### Authentication (`grace/server/auth*.py`, `grace/auth/`)

Accounts and sessions: passwords are scrypt-hashed with a per-user salt
(`password.py`), only `SHA-256(session token)` is stored (`sessions.py`),
and auth endpoints are rate-limited per IP (`rate_limit.py`). Registration
can be gated behind a closed-beta allowlist (`beta.py`). On the CLI,
`grace/auth/` holds the backend client, the local token store
(`~/.zeesh/auth.json`, 0600), and fire-and-forget usage reporting — a
backend outage never interrupts the local agent.

### Sessions (`grace/session/`, `grace/server/sessions.py`)

Two distinct things share the name:

- **Agent sessions** (`grace/session/`) — conversation history, subagent
  memory, and undo snapshots on the CLI side.
- **Login sessions** (`grace/server/sessions.py`) — user authentication
  sessions on the backend, issued at login and invalidated at logout.
- **Free-tier sessions** (`grace/server/free_sessions.py`) — the daily
  quota (3 sessions × 60 min, enforced server-side in Neon, race-safe via a
  unique constraint). A session starts only when hosted inference is
  actually required; `429 daily_limit_exhausted` is returned when the day is
  used up.

### Cost guard (`grace/costs/`, `grace/server/cost_guard.py`)

Money is accounted in integer microdollars (`costs/money.py`) with a single
pricing registry (`costs/pricing.py`). Server-side, `cost_guard.py` enforces
an internal per-user daily ceiling (default ₹20/day) with race-safe atomic
reservations in Neon, caps max output tokens to the remaining budget, settles
actual cost afterwards, and provides an optional global circuit breaker.
Users never see the economics — only a clean "capacity reached" message.

### Database (`db/migrations/`, `grace/server/db.py`)

Neon PostgreSQL schema, applied via numbered migrations:
`001_init.sql` (base), `002_auth.sql` (users/sessions), `003_closed_beta.sql`
(beta flag/allowlist), `004_free_sessions.sql` (free-tier quota), and
`005_cost_guard.sql` (usage ledger). All queries go through `grace/server/db.py`.

### Vercel functions (`api/`)

Zero-config Python serverless functions — `health.py`, `usage.py`,
`provider.py`, and `auth/*` — that import and serve the same handlers as the
`grace/server` backend, with server dependencies pinned in
`requirements.txt` and build/deploy config in `vercel.json`. The production
backend is documented and ready (`docs/deployment.md`) but not yet deployed.

### Testing (`tests/`)

pytest, with an in-memory database (`tests/helpers/memory_db.py`) and env
isolation (`tests/conftest.py`) so no test needs real API keys or
`DATABASE_URL`. Coverage spans the agent loop, fast router, context
management, safety policy, tools, provider fallback, the full backend
(auth, sessions, usage, cost guard, e2e), TUI behavior (driven headlessly
with Textual's `run_test()` pilot), and CLI UI rendering.

## Data flow for a typical run

1. The user runs `grace "fix the login bug"` in a project folder.
2. The CLI builds the repository context (`grace/project/`), and the fast
   router classifies the request as coding.
3. The primary agent plans (optionally), then loops: search → read → edit →
   run → fix → re-run, choosing validation commands itself and prompting only
   for dangerous ones.
4. Model calls go through the configured provider — locally
   (`GROQ_API_KEY`) or through the hosted router when logged in.
5. When logged in, the CLI reports usage (user, model, tokens, turns, time)
   to the backend, which records it in Neon and applies the free-tier quota
   and cost guard.
6. The agent composes a final answer with changed files, validation results,
   and stats, and the CLI renders it in the TUI or classic prompt.
