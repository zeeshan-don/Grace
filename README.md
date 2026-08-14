# GRACE

An AI coding agent that runs inside your local codebase.

An original, open-source AI coding agent that runs inside your local codebase from
the terminal. The concept: **free AI coding assistance funded by developer-focused
advertising** (not yet implemented — see [Economics & Advertising](#economics--advertising)).

```
╭──────────────────────────────────────────────────────╮
│              GRACE  v0.1.0                           │
│              AI Coding Agent                         │
│                                                      │
│  Free AI coding — supported by developer-focused     │
│  advertising (coming soon)                           │
╰──────────────────────────────────────────────────────╯
```

```bash
grace                  # interactive REPL
grace "Fix the login bug in this project"   # one-shot run
```

The agent inspects the repository, reads the relevant files, edits code, runs
tests/builds, reads errors, attempts fixes, and iterates until the task is done
or it needs your approval — then reports exactly what changed.

**Status: Milestones 1–15 implemented** — a working local agent (M1–9: CLI,
Groq, agent loop, file tools, terminal execution, safety, git, provider
abstraction), the cloud backend foundation (M10: Vercel-ready API, server-side
provider keys, Neon schema + usage recording), real authentication
(M11: user accounts + sessions, `grace login/logout/whoami`, resilient CLI→
backend usage reporting), closed-beta readiness (M12: production-safe
migrations + indexes, auth/error hardening, CORS + preflight, secret-safe
request logging, closed-beta registration gate, Vercel config, deployment + beta
checklist docs), the GRACE FREE daily session system (M13: 6 sessions/day ×
60 minutes, enforced server-side in Neon with automatic session rollover), the
subagent coordinator (M14: 9 specialized agents + a central coordinator that
plans, delegates with narrow context/permissions and composes a concise answer)
and the **primary-agent redesign** (M15: a fast local router, one primary
agent by default, optional planning only for complex tasks, a calmer CLI and
per-run instrumentation — see [Architecture](#primary-agent-architecture-milestone-15)).
The CLI stays fully local and works offline; the backend is **not deployed yet** —
deployment is documented and ready (`docs/deployment.md`).

---

## Why Grace?

GRACE is inspired by Grace Hopper, a pioneer in computer programming who helped
make programming languages more accessible to humans. The name carries that
spirit: an AI coding agent that makes programming approachable for everyone.

GRACE is an independent project and is not affiliated with, endorsed by, or
sponsored by Grace Hopper, her estate, or any related organization.

---

## Requirements

- Node.js ≥ 23.6 (runs TypeScript directly via native type stripping)
- A Groq API key — get one at <https://console.groq.com/>
- Optional (backend only): an NVIDIA NIM API key for the server-side model
  router — get one at <https://build.nvidia.com> (never needed on the CLI)

## Install & run (quick start)

**Requirement:** Node.js ≥ 23.6 (the CLI runs TypeScript directly via native
type stripping).

```bash
npm install
npm run build
npm link            # makes `grace` available globally
grace
```

Then configure your AI key (see below) and try your first task:

```bash
grace "Create a small Node app with a /hello endpoint in this project"
grace "Add a /health endpoint and a test for it"
```

Login is **optional** — local/offline use works without it:

```bash
grace register    # create a GRACE account (optional)
grace login       # log in → automatic usage reporting to the backend
grace whoami
```

### Configuration

The API key is read from (in order of precedence):

1. The `GROQ_API_KEY` environment variable
2. `<project>/.env` (auto-loaded by the CLI)
3. `~/.zeesh/env`

```bash
echo "GROQ_API_KEY=..." > .env          # per project
# or
echo "GROQ_API_KEY=..." > ~/.zeesh/env   # for every project
```

The model is persisted in `~/.zeesh/config.json` and can be changed at any
time with `/model <id>` or `--model <id>`.

> **Migrating from an older install:** versions before the rename stored
> config in `~/.myagent/`. On first run the CLI **copies** `~/.myagent/` into
> `~/.zeesh/` (env, config.json, auth.json, session/undo state) and never
> deletes the old directory — remove `~/.myagent/` yourself once you have
> confirmed everything migrated. The project-local state directory was also
> renamed (`.myagent/` → `.zeesh/` in each project); old `.myagent/` folders
> stay git-ignored and can be deleted by hand.

### Backend / API environment (Milestones 10–11)

Server-side variables for the API layer (Vercel + Neon). They are read by the
backend only — never exposed to clients:

| Variable | Used by | Purpose |
| -------- | ------- | ------- |
| `DATABASE_URL` | API | Neon PostgreSQL connection string (accounts, sessions, usage tables) |
| `GROQ_API_KEY` | CLI + API | Local agent key; also the server-side **fallback** provider for `/api/provider` |
| `NVIDIA_API_KEY` | API only | Server-side **primary** provider (NVIDIA NIM) for `/api/provider` — never sent to the CLI |
| `ZEESH_API_URL` | CLI | Backend the CLI logs in to (default `http://localhost:8787`; set to your deployed URL in production) |
| `ZEESH_BETA_MODE` | API | `closed` gates registration behind the allowlist (default `open`) |
| `ZEESH_BETA_ALLOWLIST` | API | Comma-separated emails allowed to register when closed |
| `ZEESH_CORS_ORIGIN` | API | Browser origin allowed to call the API (default `*`) |
| `ZEESH_AUTH_RATE_LIMIT_MAX` | API | Auth rate limit (default 50/15 min per IP) |
| `ZEESH_API_RATE_LIMIT_MAX` | API | API rate limit (default 300/min per IP) |
| `ZEESH_SESSIONS_PER_DAY` | API | Free-plan sessions per user per day (default 6) |
| `ZEESH_SESSION_DURATION_MINUTES` | API | Free-plan session length (default 60) |

`ZEESH_API_TOKEN` (Milestone 10's shared-token placeholder) has been removed in
favour of real per-user sessions.

### Slash commands

| Command          | What it does                                              |
| ---------------- | --------------------------------------------------------- |
| `/help`          | Show help                                                 |
| `/model`         | Show / switch the model (`/model list` lists live models) |
| `/status`        | Project type, package manager, git, model, session stats  |
| `/diff`          | Show current git changes (or agent-modified files)        |
| `/clear`         | Wipe conversation history                                 |
| `/undo`          | Revert the agent's most recent file change                |
| `/login`         | Log in to the GRACE backend (usage reporting on)       |
| `/logout`        | Log out and remove the local session                      |
| `/whoami`        | Show the authenticated identity                           |
| `/exit`          | Quit                                                      |

### CLI flags

```
--model <id>     Override the model
--yes, -y        Auto-approve flagged commands (dangerous!)
--help, -h       Show help
--version, -v    Show version
```

### Authentication (Milestone 11)

```bash
grace register [email]   # create an account (password is hidden, ≥ 8 chars)
grace login [email]      # log in — stores the session in ~/.zeesh/auth.json (0600)
grace whoami             # show the authenticated identity
grace logout             # invalidate the session server-side and remove it locally
```

The session token is persisted locally with restrictive file permissions and
is sent only to the backend as `Authorization: Bearer <token>` — `GROQ_API_KEY`
and `DATABASE_URL` never leave the server. Once logged in, the CLI reports each
agent run's usage (`user_id`, `model`, `input_tokens`, `output_tokens`,
`agent_turns`, `timestamp`, `execution_time_ms`) to the backend. Reporting is
fire-and-forget: a backend outage never interrupts the local agent (a dim note
is printed instead), and without a login the CLI stays fully offline.

### Closed beta (Milestone 12)

The backend gates registration when `ZEESH_BETA_MODE=closed` — only emails in
`ZEESH_BETA_ALLOWLIST` can create accounts (`403` otherwise). Beta testers are
flagged in `users.is_beta`. This is intentionally minimal: no dashboard, just
accounts, usage, error logging and cost tracking to measure the economics
before Milestones 15–16. Existing accounts are never locked out.

### Free plan — daily sessions (Milestone 13, GRACE FREE)

The free tier is enforced **entirely server-side** — the CLI never stores or
trusts session state, so restarting it or deleting local files can never reset
the quota:

- **6 sessions per user per day**, each **up to 60 minutes** → 6 h/day max.
- A session is a rolling 60-minute window: it starts when the first inference
  request of the day arrives and **expires automatically** 60 minutes later.
  The next request then **automatically starts the next session** — the CLI
  shows `Session X / 6` and a note when the rollover happens.
- The **day boundary is 00:00 UTC** (server-authoritative, timezone-independent).
- When all 6 sessions are used, `POST /api/provider` is refused with
  `429 { "code": "daily_limit_exhausted" }` and a `Retry-After` hint pointing
  at the next UTC day.
- `GET /api/usage` returns the full state: `sessionsUsed`, `sessionsRemaining`,
  `currentSession`, `sessionStartedAt`, `sessionExpiresAt`, `dailyUsedSeconds`,
  `dailyLimitSeconds`. Every `/api/provider` response embeds the same state
  (plus `startedNew`), and the CLI renders it in the banner, after each run and
  in `/status`.

State lives in Neon (`free_sessions`, migration `004_free_sessions.sql`); limits
are tunable via `ZEESH_SESSIONS_PER_DAY` / `ZEESH_SESSION_DURATION_MINUTES`.
Users with their own local `GROQ_API_KEY` are unaffected (they self-host and
never hit `/api/provider`).

### AI providers & model routing

The backend routes each `/api/provider` request through a **Model Router**
(`src/agents/modelRouter.ts` + `src/api/providers.ts`):

```
GRACE CLI
    ↓
Vercel /api/provider
    ↓
Model Router
    ├── NVIDIA NIM   (primary — NVIDIA_API_KEY, default model qwen/qwen2.5-coder-32b-instruct)
    └── Groq         (fallback — GROQ_API_KEY)
```

- **NVIDIA is primary** whenever `NVIDIA_API_KEY` is set server-side; Groq is
  the automatic fallback whenever `GROQ_API_KEY` is set. Both keys can be set
  at once; with only one key the chain is just that provider (Groq-only
  deployments behave exactly as before). With neither, `/api/provider`
  refuses with a clear 503.
- **Safe fallback at the model-request boundary** — if NVIDIA fails (rate
  limit, timeout, model unavailable, network, auth, malformed response), the
  *same request* is retried on Groq **before any response is consumed**, so a
  fallback can never duplicate a tool execution (tools run client-side only
  after a successful response). We never retry after a partial response.
- **Model selection** — the model id the CLI sends (configured via
  `/model <id>` or `--model`) is passed to both providers. Set an
  NVIDIA-hosted id (e.g. `qwen/qwen2.5-coder-32b-instruct` or
  `deepseek-ai/deepseek-r1`) to run on NVIDIA; any id NVIDIA does not serve
  falls through to Groq automatically.
- **Provider status** — the backend reports which provider actually served
  each request (`provider_id` / `provider_label`), and the CLI shows it:

  ```
  grace › /model
  Provider: NVIDIA NIM via GRACE backend
  Model:    qwen/qwen2.5-coder-32b-instruct
  ```

- **Failure taxonomy** — provider failures are classified
  (`authentication` / `rate_limit` / `timeout` / `unavailable_model` /
  `malformed_response` / `network`) and surfaced as secret-safe messages
  (429 for rate limits, 504 for timeouts, 502 otherwise). API keys are never
  included in errors, logs or responses — `nvapi-…` values are additionally
  redacted by the log scrubber as defense in depth.
- **Primary agent routing** — the primary agent uses the user's configured
  provider/model directly, so the CLI always shows one visible provider
  (`Grace · NVIDIA · model`). Optional specialists and the complex-task
  planning call resolve their own `(role, tier) → {provider, model}` route
  through the `ModelRouter` (thinker → reasoning model, etc.). The
  infrastructure is in place — no agent code needs to change to rewire it.

### Primary-agent architecture (Milestone 15)

GRACE is built around **one primary agent** that handles the task end to end:
it understands the request, explores the repository, reads files, edits code,
runs commands, fixes errors and iterates until the task is done. Planning and
specialized subagents are **optional** — only engaged for complex tasks or
when the user explicitly asks. This replaces the old default pipeline where
every message spawned a planner + scouts + pickers + editor + reviewer + test
runner (several LLM calls before any useful work).

```
User request
   │
   ▼
Fast local router (deterministic — no model call)
   │
   ├─ conversation → local reply (0 LLM calls)
   ├─ tests        → deterministic test runner (0 LLM calls)
   │
   └─ coding / inspect / complex
        │
        ▼
   Primary Agent  ──►  tools: search → read → edit/write → run → fix → re-run
        │
        ▼
   complex tasks only: optional planning (thinker strategy specialist)
   │
   ▼
   composed answer · changed files · validation · stats
```

- **Fast local router** (`src/agents/fastRouter.ts`) — deterministic
  classification with zero model calls. `hi`/`thanks`/`what can you do?` are
  answered locally (even without a provider); `run the tests` uses the
  deterministic runner; `build authentication`/`refactor the architecture`
  become eligible for planning; everything else starts the primary agent
  immediately.
- **Primary agent** — the editor role (`Grace`) with the full
  read/write/execute toolset and the repository index in context. It selects
  its own validation: test commands (`npm test`, `typecheck`, `build`, …)
  run without interrupting the user, while dangerous commands still prompt.
- **Optional planning** — complex tasks may run a planning phase (LLM on the
  reasoning tier with a deterministic rule-based fallback) whose strategy
  guides the primary agent. Optional specialists (thinker, researcher,
  git-curator, browser-use) only run when a plan includes them; code review
  stays off unless explicitly requested.
- **Context management** — the primary agent gets only the compact repository
  index + compacted prior results, never the whole repo; tool outputs are
  truncated and old tool results fall out of the window.
- **Provider routing** — the primary agent uses the user's configured
  provider/model directly (`Grace · NVIDIA · qwen/…`); fallback is automatic
  (server NVIDIA → Groq, client rate-limit retries). The `AIProvider`
  abstraction plus the new **DeepSeek** provider
  (`src/providers/deepseek.ts`, registered in `registry.ts`) make adding
  providers a registry + env change — never an agent change.
- **Instrumentation** — every run records LLM-call count, time to first
  response, time to first tool call, and aggregates token usage from EVERY
  internal model call (including the optional planning call) for server-side
  reporting.
- **CLI UX** — progress shows states, not a committee:

  ```
  Grace · NVIDIA NIM · qwen/qwen2.5-coder-32b-instruct

  · Grace is working…
  • → read_file src/auth/login.ts
  • → edit_file src/auth/login.ts
  • → run_command npm test
  → Grace ✓ — Authentication added
  ```

  Greetings render nothing and are answered instantly.

See [docs/coordinator.md](docs/coordinator.md) for the full architecture.

---

## How it works

```
your request
      │
      ▼
┌─────────────┐   tools:                      ┌───────────────┐
│  AgentLoop  │──► read_file / write_file /   │  run_command  │
│  (reason →  │    edit_file / search_files / │  (with safety │
│  act →      │    list_directory             │   gate +      │
│  observe)   │◄── tool results               │   redaction)  │
└─────────────┘                               └───────────────┘
      │
      ▼
 changed files · test output · final report
```

- **System prompt** is built from detected project info (type, framework,
  package manager, test/build commands).
- **Context management** estimates tokens, trims the oldest tool results, and
  truncates oversized outputs so the window stays small.
- **History** persists in `.zeesh/session.json` (auto-added to `.gitignore`);
  every file the agent modifies is snapshotted in `.zeesh/undo/` for `/undo`.

## Safety

- Commands are classified against a deny list: `rm -rf`, `sudo`, `git push` /
  `reset --hard`, database drops, infra mutations (`terraform`, `kubectl`),
  `shutdown`, piping remote scripts into a shell, and more. Flagged commands
  require `Allow? [y/N]` confirmation; denied commands are blocked.
- Protected files (`.env*`, `*.pem`, `*.key`, credentials, SSH keys) are never
  read or written by the file tools, and shell commands that touch them are
  flagged.
- Secret-shaped values (`sk-…`, `gsk_…`, private keys, GitHub/AWS tokens) are
  redacted from command output before it reaches the model.
- Non-TTY/CI sessions deny flagged commands by default; `--yes` overrides (use
  at your own risk).

## Architecture

```
LOCAL CLI (works offline; reports usage when logged in)
      │  (M11: grace login/logout/whoami → session token)
      ▼
GRACE API (src/api + api/)   ← Vercel serverless · keys stay server-side
      │                            (session auth, scrypt passwords, rate limits)
      ▼
Neon PostgreSQL (DATABASE_URL)  ·  AI providers (src/providers)

CLI (src/cli)  →  AgentLoop (src/agent)  →  Tools (src/tools)  →  project / git / safety
                     │
                     ▼
              AIProvider (src/providers)     ← provider-agnostic
                     │
                     ▼
               GroqProvider · NvidiaProvider (implemented)
               Gemini/Anthropic/OpenAI/Ollama (extension points)
```

Key directories:

```
src/
  cli/        banner, REPL, slash commands, one-shot runner, taskRunner (coordinator wiring)
  agents/     coordinator.ts · planner.ts · specs.ts · subagent.ts · capabilities.ts
              · compact.ts · structured.ts · modelRouter.ts · browser.ts
  agent/      loop.ts (reason→act→observe) · context.ts (token budget)
  tools/      read_file, write_file, edit_file, search_files,
              list_directory, run_command, git_diff, web_fetch
  providers/  types.ts (AIProvider contract) · groq.ts · nvidia.ts · fallback.ts
              · errors.ts (failure taxonomy) · registry.ts
  api/        backend (M10): handlers, server-side providers, usage,
              db (Neon), auth-ready guard, local dev server
  project/    detect.ts (type/framework/PM detection) · index.ts (repo index)
              · gitignore.ts · walker.ts
  safety/     policy.ts (dangerous commands, protected files, redaction)
  session/    session.ts (history) · memory.ts (subagent sessions) · undo.ts (snapshots)
  auth/       client.ts (backend API) · session.ts (local token store) ·
              reporting.ts (resilient usage reporting)
  cli/        authCommands.ts (login/register/logout/whoami) · input.ts (hidden passwords)
              · freePlan.ts (free-session display helpers)
api/          Vercel zero-config serverless functions (health, auth/*, usage, provider)
db/           migrations/001_init.sql … 004_free_sessions.sql (Neon schema)
tests/        unit + agent-loop + coordinator + API + auth + CLI tests (node --test)
```

## Backend & API (Milestones 10–11)

The cloud foundation for accounts, sessions, usage tracking, model routing and
the ad-funded free tier. The local CLI is untouched and keeps working offline
with its own local Groq key; logging in adds usage reporting.

```
LOCAL CLI  →  GRACE API  →  Vercel  →  Neon PostgreSQL  →  AI providers
```

- **Real authentication (M11)** — user accounts (`users`) and sessions
  (`sessions`). Passwords are scrypt-hashed with a per-user salt
  (`src/api/password.ts`); only `SHA-256(session token)` is stored
  (`src/api/sessions.ts`). The shared `ZEESH_API_TOKEN` placeholder is gone.
- **Production hardening (M12)** — every endpoint goes through `withHttp`
  (`src/api/middleware.ts`): CORS + `OPTIONS` preflight, secret-safe error
  responses (unexpected failures return a generic `500` — no stack traces,
  provider errors are sanitized), and one scrub-safe log line per request
  (`src/api/log.ts` — never passwords/tokens/keys/URLs). Registration can be
  gated by the closed-beta allowlist (`src/api/beta.ts`).
- **Auth endpoints** — `POST /api/auth/register`, `POST /api/auth/login`,
  `POST /api/auth/logout`, `GET /api/auth/me`. Auth endpoints are rate-limited
  per IP (`src/api/rateLimit.ts`).
- **Protected endpoints** — `/api/usage` and `/api/provider` now require a
  valid session and scope data to the authenticated user (a caller can no
  longer record or read another user's usage).
- **Server-side provider layer** — `src/api/providers.ts` reuses the existing
  `AIProvider` abstraction, but provider keys (`NVIDIA_API_KEY`, `GROQ_API_KEY`)
  live on the server so production keys never reach the CLI or the browser.
  `createServerRouter` builds the Model Router chain (NVIDIA primary → Groq
  fallback) per request; failures are classified and reported without secrets.
- **Neon PostgreSQL** — `src/api/db.ts` connects via `DATABASE_URL` (lazily,
  so the API still boots without a database). Schema in
  `db/migrations/001_init.sql` … `004_free_sessions.sql`.
- **Usage recording** — the CLI reports `user_id`, `model`, `input_tokens`,
  `output_tokens`, `agent_turns`, `timestamp` and `execution_time_ms` after
  each run when logged in (`src/auth/reporting.ts`). Reporting is
  fire-and-forget and never breaks the local agent (see `docs/api.md`).
- **Free plan sessions (M13)** — `src/api/freeSessions.ts` enforces 6 sessions
  of 60 minutes per user per UTC day on the server (`free_sessions` table,
  race-safe via a unique constraint). `/api/provider` is gated before any model
  call; expired sessions auto-roll into the next one and a fully-used day gets
  `429 daily_limit_exhausted`. See [Free plan — daily sessions](#free-plan--daily-sessions-milestone-13-grace-free).

Run it locally:

```bash
npm run serve                  # http://localhost:8787
npm run smoke                  # scripted health + endpoint smoke test
curl http://localhost:8787/api/health
grace register               # create an account
grace login                  # log in (usage reporting turns on)
grace whoami
```

Deployment to Vercel is documented and ready (`docs/deployment.md` +
`vercel.json`) but deliberately **not** performed yet — no credentials are
available here. `api/*.ts` are zero-config serverless functions.

To add a provider, implement `AIProvider` in `src/providers/` and register it in
`registry.ts`. The rest of the app never touches SDK-specific types.

## Development

```bash
npm run dev          # run the CLI from source (no build)
npm run serve        # run the API locally (Milestones 10–11 backend)
npm test             # unit + integration + API tests
npm run typecheck    # tsc --noEmit (src + tests + api)
npm run build        # emit dist/
```

## Roadmap

| #  | Milestone                     | Status                       |
| -- | ----------------------------- | ---------------------------- |
| 1  | Working CLI                   | ✅ done                      |
| 2  | Groq integration              | ✅ done                      |
| 3  | Agent loop                    | ✅ done                      |
| 4  | File tools                    | ✅ done                      |
| 5  | Terminal execution            | ✅ done                      |
| 6  | Automatic error fixing        | ✅ (part of the loop)        |
| 7  | Safety / permissions          | ✅ (core gates)              |
| 8  | Git integration               | ✅ (basic status/diff/log)   |
| 9  | Provider abstraction          | ✅ (interface + Groq + NVIDIA NIM with router fallback) |
| 10 | Backend + Neon                | ✅ (API, server-side providers, Neon schema + usage) |
| 11 | Auth + usage tracking         | ✅ (user accounts + sessions, CLI login/logout/whoami, resilient usage reporting) |
| 12 | Closed beta                   | ✅ (hardening, CORS, safe logging, closed-beta gate, Vercel config, deployment + beta checklist docs — deploy not yet performed) |
| 13 | GRACE FREE daily sessions     | ✅ (6 sessions/day × 60 min, server-enforced in Neon, auto-rollover, CLI quota display, tests — no ads, no fake numbers) |
| 14 | Subagent coordinator          | ✅ (9 specialized agents + central coordinator: planning, narrow context + permissions, parallel delegation, failure recovery, project index, CLI progress UX — tests + docs) |
| 15 | Primary-agent redesign        | ✅ (fast local router, one primary agent by default, optional planning for complex tasks only, calmer state-based CLI progress, per-run instrumentation — LLM calls / time-to-first-tool, DeepSeek provider added, usage from every internal call aggregated — tests + docs) |
| 16 | Measure real AI cost/user     | ⏳ (economics docs + `models` pricing table ready — needs live data) |
| 17 | Advertising (after economics) | ⏳                          |

## Validation records

Formal acceptance records proving the agent's autonomous capabilities on real
projects (create → run → break → diagnose → fix → verify → clean up):

| Record | What it proves |
| ------ | -------------- |
| [Validation milestone 01](docs/validation-milestone-01.md) | Autonomous end-to-end diagnose/fix/verify loop on a throwaway Node.js HTTP app — without touching the agent's own source, no secrets, full cleanup |
| [Validation milestone 02](docs/validation-milestone-02.md) | Milestone 12 closed-beta end-to-end: real CLI + Groq on a throwaway project (create → modify → break → fix → verify), auth + usage reporting against the local API, offline resilience |

## Economics & advertising

The eventual business model:

```
Advertisers → ad revenue → AI inference + infrastructure → free coding agent → developers
```

Advertising is deliberately **not** implemented yet. The system is architected
for it:

- Usage accounting (`Session.stats`: runs, tool calls, input/output tokens) is
  tracked locally and persisted per project.
- The backend (Milestones 10–11) records `user_id`, `model`, `input_tokens`,
  `output_tokens`, `agent_turns`, `timestamp`, and `execution_time_ms` into
  Neon (`usage` + `agent_runs`, schema in `db/migrations/`) and estimates
  per-user AI cost via the `user_economics` view
  (`docs/database.md`, `docs/api.md`). The CLI reports usage to it after each
  run whenever a session exists (`grace login`).
- Ads must be developer-focused (cloud, hosting, dev tools, AI APIs, DBs) and
  must never use private source code, secrets, or user data.

## Known limitations (v0.1)

- Token usage from streaming is estimated (Groq only reports usage on the final
  chunk via `x_groq`); the CLI reports the estimate to the backend per run.
- No multi-turn "continue after iteration limit" resume UI beyond sending
  another message.
- `run_command` on Windows uses `cmd.exe` by default; set `ZEESH_SHELL` to
  your shell of choice (e.g. `bash`) if you need POSIX builtins.
- Usage reporting requires the user to log in (`grace login`); without a
  session the CLI stays fully offline and records nothing.
- The rate limiter is in-memory (per server instance) — a shared store
  (Redis/Upstash) is a closed-beta concern.
- The backend is not deployed to Vercel yet; `api/*.ts` are ready (see
  `docs/deployment.md`). Ads, payments, subscriptions and dashboards remain out
  of scope by design (Milestones 15–16).

## License

MIT
