# myagent — Terminal AI Coding Agent

An original, open-source AI coding agent that runs inside your local codebase from
the terminal. The concept: **free AI coding assistance funded by developer-focused
advertising** (not yet implemented — see [Economics & Advertising](#economics--advertising)).

```
╭──────────────────────────────────────────────────────╮
│  myagent  v0.1.0                                     │
│  Terminal AI Coding Agent                            │
│                                                      │
│  Free AI coding — supported by developer-focused     │
│  advertising (coming soon)                           │
╰──────────────────────────────────────────────────────╯
```

```bash
myagent                # interactive REPL
myagent "Fix the login bug in this project"   # one-shot run
```

The agent inspects the repository, reads the relevant files, edits code, runs
tests/builds, reads errors, attempts fixes, and iterates until the task is done
or it needs your approval — then reports exactly what changed.

**Status: Milestones 1–12 implemented** — a working local agent (M1–9: CLI,
Groq, agent loop, file tools, terminal execution, safety, git, provider
abstraction), the cloud backend foundation (M10: Vercel-ready API, server-side
provider keys, Neon schema + usage recording), real authentication
(M11: user accounts + sessions, `myagent login/logout/whoami`, resilient CLI→
backend usage reporting) and closed-beta readiness (M12: production-safe
migrations + indexes, auth/error hardening, CORS + preflight, secret-safe
request logging, closed-beta registration gate, Vercel config, deployment + beta
checklist docs). The CLI stays fully local and works offline; the backend is
**not deployed yet** — deployment is documented and ready (`docs/deployment.md`).

---

## Requirements

- Node.js ≥ 23.6 (runs TypeScript directly via native type stripping)
- A Groq API key — get one at <https://console.groq.com/>

## Install & run (quick start)

**Requirement:** Node.js ≥ 23.6 (the CLI runs TypeScript directly via native
type stripping).

```bash
npm install
npm run build
npm link            # makes `myagent` available globally
myagent
```

Then configure your AI key (see below) and try your first task:

```bash
myagent "Create a small Node app with a /hello endpoint in this project"
myagent "Add a /health endpoint and a test for it"
```

Login is **optional** — local/offline use works without it:

```bash
myagent register    # create a ZEESH AI account (optional)
myagent login       # log in → automatic usage reporting to the backend
myagent whoami
```

### Configuration

The API key is read from (in order of precedence):

1. The `GROQ_API_KEY` environment variable
2. `<project>/.env` (auto-loaded by the CLI)
3. `~/.myagent/env`

```bash
echo "GROQ_API_KEY=..." > .env          # per project
# or
echo "GROQ_API_KEY=..." > ~/.myagent/env   # for every project
```

The model is persisted in `~/.myagent/config.json` and can be changed at any
time with `/model <id>` or `--model <id>`.

### Backend / API environment (Milestones 10–11)

Server-side variables for the API layer (Vercel + Neon). They are read by the
backend only — never exposed to clients:

| Variable | Used by | Purpose |
| -------- | ------- | ------- |
| `DATABASE_URL` | API | Neon PostgreSQL connection string (accounts, sessions, usage tables) |
| `GROQ_API_KEY` | CLI + API | Also used server-side so production keys never reach the CLI |
| `ZEESH_API_URL` | CLI | Backend the CLI logs in to (default `http://localhost:8787`; set to your deployed URL in production) |
| `ZEESH_BETA_MODE` | API | `closed` gates registration behind the allowlist (default `open`) |
| `ZEESH_BETA_ALLOWLIST` | API | Comma-separated emails allowed to register when closed |
| `ZEESH_CORS_ORIGIN` | API | Browser origin allowed to call the API (default `*`) |
| `ZEESH_AUTH_RATE_LIMIT_MAX` | API | Auth rate limit (default 50/15 min per IP) |
| `ZEESH_API_RATE_LIMIT_MAX` | API | API rate limit (default 300/min per IP) |

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
| `/login`         | Log in to the ZEESH AI backend (usage reporting on)       |
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
myagent register [email]   # create an account (password is hidden, ≥ 8 chars)
myagent login [email]      # log in — stores the session in ~/.myagent/auth.json (0600)
myagent whoami             # show the authenticated identity
myagent logout             # invalidate the session server-side and remove it locally
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
before Milestones 13–14. Existing accounts are never locked out.

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
- **History** persists in `.myagent/session.json` (auto-added to `.gitignore`);
  every file the agent modifies is snapshotted in `.myagent/undo/` for `/undo`.

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
      │  (M11: myagent login/logout/whoami → session token)
      ▼
ZEESH AI API (src/api + api/)   ← Vercel serverless · keys stay server-side
      │                            (session auth, scrypt passwords, rate limits)
      ▼
Neon PostgreSQL (DATABASE_URL)  ·  AI providers (src/providers)

CLI (src/cli)  →  AgentLoop (src/agent)  →  Tools (src/tools)  →  project / git / safety
                     │
                     ▼
              AIProvider (src/providers)     ← provider-agnostic
                     │
                     ▼
               GroqProvider (implemented)
               Gemini/Anthropic/OpenAI/NVIDIA/Ollama (extension points)
```

Key directories:

```
src/
  cli/        banner, REPL, slash commands, one-shot runner
  agent/      loop.ts (reason→act→observe) · context.ts (token budget)
  tools/      read_file, write_file, edit_file, search_files,
              list_directory, run_command
  providers/  types.ts (AIProvider contract) · groq.ts · registry.ts
  api/        backend (M10): handlers, server-side providers, usage,
              db (Neon), auth-ready guard, local dev server
  project/    detect.ts (type/framework/PM detection) · gitignore.ts · walker.ts
  safety/     policy.ts (dangerous commands, protected files, redaction)
  session/    session.ts (history) · undo.ts (snapshots)
  auth/       client.ts (backend API) · session.ts (local token store) ·
              reporting.ts (resilient usage reporting)
  cli/        authCommands.ts (login/register/logout/whoami) · input.ts (hidden passwords)
api/          Vercel zero-config serverless functions (health, auth/*, usage, provider)
db/           migrations/001_init.sql + 002_auth.sql (Neon schema)
tests/        unit + agent-loop + API + auth + CLI tests (node --test)
```

## Backend & API (Milestones 10–11)

The cloud foundation for accounts, sessions, usage tracking, model routing and
the ad-funded free tier. The local CLI is untouched and keeps working offline
with its own local Groq key; logging in adds usage reporting.

```
LOCAL CLI  →  ZEESH AI API  →  Vercel  →  Neon PostgreSQL  →  AI providers
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
  `AIProvider` abstraction, but `GROQ_API_KEY` lives on the server so
  production keys never reach the CLI or the browser.
- **Neon PostgreSQL** — `src/api/db.ts` connects via `DATABASE_URL` (lazily,
  so the API still boots without a database). Schema in
  `db/migrations/001_init.sql` + `002_auth.sql`.
- **Usage recording** — the CLI reports `user_id`, `model`, `input_tokens`,
  `output_tokens`, `agent_turns`, `timestamp` and `execution_time_ms` after
  each run when logged in (`src/auth/reporting.ts`). Reporting is
  fire-and-forget and never breaks the local agent (see `docs/api.md`).

Run it locally:

```bash
npm run serve                  # http://localhost:8787
npm run smoke                  # scripted health + endpoint smoke test
curl http://localhost:8787/api/health
myagent register               # create an account
myagent login                  # log in (usage reporting turns on)
myagent whoami
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
| 9  | Provider abstraction          | ✅ (interface + Groq, more later) |
| 10 | Backend + Neon                | ✅ (API, server-side providers, Neon schema + usage) |
| 11 | Auth + usage tracking         | ✅ (user accounts + sessions, CLI login/logout/whoami, resilient usage reporting) |
| 12 | Closed beta                   | ✅ (hardening, CORS, safe logging, closed-beta gate, Vercel config, deployment + beta checklist docs — deploy not yet performed) |
| 13 | Measure real AI cost/user     | ⏳ (economics docs + `models` pricing table ready — needs live data) |
| 14 | Advertising (after economics) | ⏳                          |

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
  run whenever a session exists (`myagent login`).
- Ads must be developer-focused (cloud, hosting, dev tools, AI APIs, DBs) and
  must never use private source code, secrets, or user data.

## Known limitations (v0.1)

- Token usage from streaming is estimated (Groq only reports usage on the final
  chunk via `x_groq`); the CLI reports the estimate to the backend per run.
- No multi-turn "continue after iteration limit" resume UI beyond sending
  another message.
- `run_command` on Windows uses `cmd.exe` by default; set `MYAGENT_SHELL` to
  your shell of choice (e.g. `bash`) if you need POSIX builtins.
- Usage reporting requires the user to log in (`myagent login`); without a
  session the CLI stays fully offline and records nothing.
- The rate limiter is in-memory (per server instance) — a shared store
  (Redis/Upstash) is a closed-beta concern.
- The backend is not deployed to Vercel yet; `api/*.ts` are ready (see
  `docs/deployment.md`). Ads, payments, subscriptions and dashboards remain out
  of scope by design (Milestones 13–14).

## License

MIT
#   Z e e s h - A i  
 #   Z e e s h - A i  
 