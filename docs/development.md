# Development

This document is written for contributors: how Grace is put together, where
to look when you want to change something, and how the different run modes
(CLI, backend, local development, production) relate to each other.

For setup, testing, and the contribution workflow, see
[CONTRIBUTING.md](../CONTRIBUTING.md). For a component-by-component
description, see [architecture.md](architecture.md).

## The big picture

```
Python CLI (grace)
     │  prompt · tools · usage reporting
     ▼
Agent (reason → act → observe)
     │
     ├──► Tools (filesystem, search, commands, git, web)
     └──► Providers (Groq · NVIDIA · Gemini · MiniMax · DeepSeek)
              │  (model calls; hosted routing when logged in)
              ▼
Python backend (grace/server — WSGI, deployed as Vercel functions)
     │
     ├──► Neon PostgreSQL (db/migrations)  ·  auth  ·  sessions
     └──► AI providers (server-side keys)  ·  cost guard
```

The CLI is a self-contained Python package that works fully offline with your
own provider key. The backend adds accounts, sessions, usage reporting,
free-tier quotas, and server-side model routing — the CLI talks to it only
when you are logged in (`grace login`).

## Where to look when modifying…

### Agent behavior

- `grace/agent/` — the core reason → act → observe loop and context management.
- `grace/agents/` — the coordinator, planner, fast router, model router,
  subagents, capabilities, and the deterministic test runner.
- `grace/project/` — project detection and the compact repository index fed
  into the agent's context.

Start with `grace/agents/` if you are changing *which* agents run and how they
are orchestrated; start with `grace/agent/` for the loop itself.

### Providers

- `grace/providers/` — one module per provider (`groq.py`, `nvidia.py`,
  `gemini.py`, `minimax.py`, `deepseek.py`), the shared `AIProvider`
  contract (`types.py`), the fallback chain (`fallback.py`), the failure
  taxonomy (`errors.py`), and the registry (`registry.py`).
- `grace/server/providers.py` — the server-side chain built from
  server-only keys.
- `grace/costs/pricing.py` — the centralized pricing registry used to
  estimate cost per model.

Adding a provider means implementing the contract, registering it, and (for
hosted routing) wiring it into `grace/agents/model_router.py` and
`grace/server/providers.py`. No agent code needs to change.

### Tools

- `grace/tools/` — `read_file`, `write_file`, `edit_file`, `search_files`,
  `list_directory`, `run_command`, `git_diff`, `web_fetch`, and the
  registry (`registry.py`).
- `grace/safety.py` — the command deny list, protected files, and secret
  redaction that gate the tools.

Tools are security-sensitive: any change here affects what the agent can
read, write, and execute.

### TUI

- `grace/cli/tui/` — the full-screen Textual app: `app.py`, `store.py`,
  `runner.py`, `events.py`, `models.py`, pickers, palette, and permission
  dialogs.
- `grace/cli/ui/` — the classic `grace>` prompt's progress and results
  rendering.
- Tests: `tests/test_tui_*.py` drive the real app headlessly with Textual's
  `run_test()` pilot.

### Sessions

- CLI side: `grace/session/` — conversation history (`session.py`), subagent
  memory (`memory.py`), and undo snapshots (`undo.py`).
- Backend side: `grace/server/sessions.py` (login sessions) and
  `grace/server/free_sessions.py` (the free-tier daily quota, enforced
  server-side in Neon).

### Costs

- `grace/costs/` — integer microdollar accounting (`money.py`) and the
  pricing registry (`pricing.py`).
- `grace/server/cost_guard.py` — the per-user daily ceiling, race-safe
  reservations, and the global circuit breaker.

### Authentication

- CLI side: `grace/auth/` — the backend API client, local token store, and
  resilient usage reporting; commands in `grace/cli/auth_commands.py`.
- Backend side: `grace/server/auth.py`, `auth_service.py`, `password.py`
  (scrypt), `sessions.py`, and `rate_limit.py`.

### Backend

- `grace/server/` — the WSGI app (`serve.py`, `wsgi.py`), route handlers
  (`handlers.py`), middleware (`middleware.py`: CORS, safe errors, scrub-safe
  logging), and the database layer (`db.py`).

### Vercel API

- `api/` — thin Vercel Python functions (`health.py`, `usage.py`,
  `provider.py`, `auth/…`) that import and serve the same handlers as
  `grace/server`. Deploy config lives in `vercel.json`; server dependencies
  are pinned in `requirements.txt`.

### Tests

- `tests/` — pytest. `conftest.py` clears provider/database env vars and
  wires an in-memory database (`tests/helpers/memory_db.py`) into the
  backend, so tests never need real keys or a real database.
- `tests/test_server_*.py` — backend/auth/usage/cost-guard tests.
- `tests/test_agent_loop.py`, `tests/test_fast_router.py`,
  `tests/test_context.py` — agent behavior.
- `tests/test_fallback.py` — provider fallback behavior.
- `tests/test_tools.py`, `tests/test_safety.py` — tools and safety policy.
- `tests/test_tui_*.py`, `tests/test_ui.py` — TUI and classic prompt.

## CLI vs. backend vs. local development vs. production

| Mode | What runs | How to run | What it needs |
| ---- | --------- | ---------- | ------------- |
| **CLI (local)** | `grace/` Python package: REPL, TUI, one-shot runner, agent, tools | `grace` or `python -m grace` | Python ≥ 3.10; a provider key (`GROQ_API_KEY` in `.env`) or a login |
| **Backend (local dev)** | `grace/server` WSGI app | `python -m grace.server.serve` → http://localhost:8787 | Nothing to boot; `DATABASE_URL` for real accounts/usage/quota |
| **CLI → local backend** | CLI talking to the local server | `ZEESH_API_URL=http://localhost:8787 grace login` | The local server running |
| **Production** | Vercel functions (`api/`) + Neon PostgreSQL | Deploy `api/` to Vercel (see `docs/deployment.md`); set `DATABASE_URL` and provider keys as Vercel env vars | Vercel env: `DATABASE_URL`, server provider keys, `ZEESH_*` tuning |

Key differences:

- **The CLI never needs server-side keys.** `GROQ_API_KEY` works both locally
  and server-side; `NVIDIA_API_KEY`, `GEMINI_API_KEY`, `MINIMAX_API_KEY`, and
  `DEEPSEEK_API_KEY` are server-only.
- **The backend is not deployed yet** — `vercel.json` and `api/` are ready,
  but the production backend is deliberately not live. Local development runs
  the same handlers through `python -m grace.server.serve`.
- **Production behavior** is configured entirely through environment
  variables (`ZEESH_*`), never code changes — see `.env.example` and
  `docs/deployment.md`.

## Code quality

There is intentionally no large linting stack. Ruff is configured with a
minimal, safe rule set (`F`, `I`, `E4/E7/E9` — see `pyproject.toml`) and is
part of the `dev` extras:

```bash
ruff check
python -m pytest
python -m compileall -q grace api tests
```

CI runs the tests, compile checks and a package build (`python -m build`).
Match the style of the code you touch and keep the dependency list small.
