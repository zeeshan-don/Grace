# GRACE

**An AI coding agent that runs inside your local codebase.**

GRACE is an open-source, terminal-based AI coding agent. Run it inside any
project folder and it will inspect the repository, read the relevant files,
edit code, run tests and build commands, read the errors, attempt fixes, and
iterate until the task is done or it needs your approval — then report
exactly what changed.

The concept behind the project: **free AI coding assistance**, funded by
developer-focused advertising (not yet implemented — see
[docs/economics.md](docs/economics.md)).

The name is inspired by [Grace Hopper](https://en.wikipedia.org/wiki/Grace_Hopper),
a pioneer of programming languages. GRACE is an independent project and is
not affiliated with, endorsed by, or sponsored by Grace Hopper, her estate,
or any related organization.

---

## What it does

- Inspects your repository and builds a compact index of the project (type,
  framework, package manager, test/build commands).
- Reasons through a **reason → act → observe** loop: search → read → edit →
  run → fix → re-run, choosing its own validation commands.
- Works **fully offline** with your own provider key, or through the hosted
  GRACE backend when you log in.
- Interacts with **git** (status/diff) and keeps an **undo** snapshot of
  every file it modifies.
- Flags dangerous commands (`rm -rf`, `sudo`, `git push`, …) and protects
  secret files (`.env*`, `*.pem`, `*.key`, …) behind a safety policy.
- Runs in a **full-screen interactive TUI** (Textual) or the classic
  `grace>` prompt for piped/CI sessions.

## Requirements

- **Python ≥ 3.10** and `pip`
- Optional — a Groq API key for fully local inference:
  <https://console.groq.com/> (not needed when you log in via `grace login`,
  the hosted backend provides the model)
- Optional (backend only) — server-side provider keys for the model router:
  NVIDIA NIM, Gemini, MiniMax (see [Configuration](#configuration))

## Installation

```bash
pip install .
```

This installs the `grace` command. From a checkout (for development):

```bash
pip install -e ".[dev]"
```

## Quick start

```bash
cd path/to/your/project
grace
```

This starts the interactive REPL. Type a task in plain English — for
example:

```bash
grace "Add a /health endpoint and a test for it"
```

One-shot mode runs the task and exits:

```bash
grace "Fix the login bug in this project"
```

Login is **optional** — local/offline use works without it:

```bash
grace register    # create a GRACE account (optional)
grace login       # log in → hosted model access + usage reporting
grace whoami      # show the authenticated identity
grace logout      # log out
```

Without a provider key or login, greetings, `/help` and `/status` still work;
real agent work needs a model (a local `GROQ_API_KEY` in `.env`, or a login).

## CLI usage

### Subcommands

| Command | What it does |
| ------- | ------------ |
| `grace` | Start the interactive REPL |
| `grace "task"` | One-shot run, then exit |
| `grace register [email]` | Create a GRACE account |
| `grace login [email]` | Log in (password is hidden, ≥ 8 chars) |
| `grace logout` | Invalidate the session server-side and remove it locally |
| `grace whoami` | Show the authenticated identity |

### Flags

```
--model <id>     Override the model (e.g. openai/gpt-oss-20b)
--yes, -y        Auto-approve flagged commands (dangerous!)
--new-window     Start Grace in a new terminal window (workspace preserved)
--verbose        Show verbose diagnostics (raw output, agent details)
--debug          Alias for --verbose
--help, -h       Show help
--version, -v    Show version
```

### Slash commands (inside the REPL)

| Command | What it does |
| ------- | ------------ |
| `/help` | Show help |
| `/status` | Workspace, git, model and session status |
| `/model` | Show current provider & model |
| `/model <id>` | Switch model (e.g. `/model qwen/qwen3.6-27b`) |
| `/model list` | List models available on the provider |
| `/provider` | Show how the provider is selected |
| `/provider groq` | Use a local Groq key for this session |
| `/cd <path>` | Change the active workspace safely |
| `/diff` | Show current git changes (or agent-modified files) |
| `/clear` | Clear the terminal screen |
| `/reset` | Clear the conversation/task context (keeps the workspace) |
| `/undo` | Revert the last file change made by the agent |
| `/debug` | Toggle debug diagnostics (also `/verbose`) |
| `/login` · `/logout` · `/whoami` | Authentication |
| `/exit` | Quit (also `/quit`, Ctrl+C, Ctrl+D) |

Conversation history persists in `.zeesh/session.json`; `/reset` clears it
while keeping the workspace.

## TUI

On a real terminal (TTY with ANSI support — Windows Terminal, VS Code
terminal, modern conhost, most terminals), `grace` opens a **full-screen
interactive TUI** built with [Textual](https://textual.textualize.io/): a
real text input with cursor editing and history, a live activity feed,
interactive model/provider pickers, a slash-command palette, and permission
dialogs. Your previous shell output is restored on exit.

- `grace --new-window` starts the TUI in a new terminal window.
- On piped/non-TTY sessions, or if the TUI cannot load, Grace automatically
  falls back to the classic `grace>` prompt — the agent is identical.

## Configuration

The API key is read from (in order of precedence):

1. The `GROQ_API_KEY` **environment variable** (always wins)
2. `~/.zeesh/env` (user-level, every project)
3. `<project>/.env` (project-level)

```bash
echo "GROQ_API_KEY=..." > .env            # per project
# or
echo "GROQ_API_KEY=..." > ~/.zeesh/env   # for every project
```

The selected model is persisted in `~/.zeesh/config.json` and can be changed
at any time with `/model <id>` or `--model <id>`.

| Variable | Used by | Purpose |
| -------- | ------- | ------- |
| `GROQ_API_KEY` | CLI + API | Local agent key; also the server-side **primary** provider for `/api/provider` |
| `ZEESH_API_URL` | CLI | Backend the CLI logs in to (default `https://grace.zeeshstudios.in`; set to `http://localhost:8787` only for local development) |
| `NVIDIA_API_KEY` / `GEMINI_API_KEY` / `MINIMAX_API_KEY` / `DEEPSEEK_API_KEY` | API only | Server-side fallback providers — never needed on the CLI |
| `DATABASE_URL` | API | Neon PostgreSQL connection string (accounts, sessions, usage) |
| `ZEESH_SHELL` | CLI | Override the shell used by `run_command` |
| `NO_COLOR` | CLI | Disable ANSI colors |

See [`.env.example`](.env.example) for the full list of backend variables
(beta allowlist, free-tier quota, cost limits, rate limits).

> **Migrating from an older install:** versions before the rename stored
> config in `~/.myagent/`. On first run the CLI copies `~/.myagent/` into
> `~/.zeesh/` and never deletes the old directory — remove `~/.myagent/`
> yourself once you have confirmed everything migrated.

## Architecture

```
Python CLI (grace)
     │  task · tool calls · usage reporting
     ▼
Agent loop (reason → act → observe)
     ├──► Tools (grace/tools/)     — read/write/edit/search/run/git/web,
     │                               gated by grace/safety.py
     └──► Providers (grace/providers/) — Groq · NVIDIA NIM · Gemini ·
                                          MiniMax · DeepSeek, fallback chain
              │  model calls (hosted routing when logged in)
              ▼
Python backend (grace/server — WSGI, deployable as Vercel functions)
     ├──► Neon PostgreSQL (db/migrations) · auth · sessions · free-tier
     └──► AI providers (server-side keys) · cost guard
```

- **CLI** (`grace/cli/`) — entry point, REPL, one-shot runner, slash
  commands, the Textual TUI (`cli/tui/`), and classic-prompt rendering
  (`cli/ui/`).
- **Agent** (`grace/agent/`, `grace/agents/`) — the reason → act → observe
  loop, context management, a deterministic fast router, an optional planner
  and specialized subagents for complex tasks.
- **Tools** (`grace/tools/`) — `read_file`, `write_file`, `edit_file`,
  `search_files`, `list_directory`, `run_command`, `git_diff`, `web_fetch`.
- **Providers** (`grace/providers/`) — one module per provider behind a
  shared `AIProvider` contract, with a safe fallback chain and a failure
  taxonomy.
- **Backend** (`grace/server/`, `api/`) — accounts, sessions, usage
  reporting, the free-tier daily quota, server-side model routing, and
  internal cost protection. The CLI is fully offline-capable; the backend is
  optional and not yet deployed to production (`docs/deployment.md`).

See [docs/architecture.md](docs/architecture.md) for the full component map
and [docs/development.md](docs/development.md) for where to look when
changing behavior.

### Grace Free

The hosted backend offers **3 sessions per user per day × 60 minutes**,
enforced entirely server-side (Neon) — restarting the CLI can never reset
the quota. Users with their own local `GROQ_API_KEY` are unaffected. Under
the hood the backend enforces an internal daily cost ceiling (₹20/day/user)
with race-safe reservations and an optional global circuit breaker; users
never see the economics. See [docs/economics.md](docs/economics.md).

## Website

The official GRACE website is a static, dependency-free site in
[`public/`](public/). It ships with the repository and deploys to Vercel
from the same project as the Python API. Run it locally with:

```bash
python -m http.server 8000 --directory public   # http://localhost:8000
```

See [docs/deployment.md](docs/deployment.md) for how the site and the API
coexist on Vercel.

## Development & testing

```bash
pip install -e ".[dev]"     # install the CLI + dev extras (pytest)
python -m pytest            # full test suite (no API keys or DB needed)
python -m compileall -q grace api tests   # syntax check
ruff check                  # lint (F, I, E4/E7/E9)
python -m build             # build sdist + wheel
```

Tests use mocks and an in-memory database — **no API keys and no
`DATABASE_URL` are required**. CI runs the test suite, compile checks and a
package build on Python 3.10, 3.11, 3.12 and 3.13.

Run the local backend (for auth/usage/quota development):

```bash
python -m grace.server.serve    # http://localhost:8787
curl http://localhost:8787/api/health
```

Point the CLI at it with `ZEESH_API_URL=http://localhost:8787`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor workflow and
[docs/development.md](docs/development.md) for the project from a
contributor's perspective.

## Known limitations

- The full-screen TUI activates only on a real terminal; piped/CI sessions
  get the classic `grace>` prompt.
- `run_command` on Windows uses `cmd.exe` by default; set `ZEESH_SHELL` to
  your shell of choice (e.g. `bash`) for POSIX builtins.
- The backend is not deployed to Vercel yet — deployment is documented and
  ready ([docs/deployment.md](docs/deployment.md)).
- Advertising is not implemented; usage accounting and the pricing registry
  are in place to measure the economics first
  ([docs/economics.md](docs/economics.md)).

## Contributing

Community contributions are welcome — bug reports, feature ideas,
documentation, tests, and code. Before you start, please read:

- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, tests, and the PR workflow
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — community standards
- [SECURITY.md](SECURITY.md) — how to report security vulnerabilities
  privately
- [docs/roadmap.md](docs/roadmap.md) — where the project is heading

**Please be careful:** Grace is a coding agent that reads, writes, and edits
files, runs commands, and interacts with git. Always test it in a safe,
disposable development repository — never on projects you cannot afford to
lose. Never include secrets, API keys, or credentials in issues or pull
requests.

## License

[MIT](LICENSE)
