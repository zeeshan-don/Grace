# Contributing to Grace

Thanks for your interest in Grace! Grace is a free, open-source AI coding
agent that runs inside your local codebase from the terminal. This guide
explains how the project is organized and how to contribute: setting up a
development environment, running the tests, making changes, and submitting a
pull request.

Please also read:

- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — community standards we expect everyone to follow
- [SECURITY.md](SECURITY.md) — how to report security vulnerabilities privately
- [docs/development.md](docs/development.md) — the project from a contributor's perspective
- [docs/architecture.md](docs/architecture.md) — how the pieces fit together
- [docs/roadmap.md](docs/roadmap.md) — where the project is heading

---

## What is Grace?

Grace is a terminal AI coding agent. You launch it inside a project folder and
it inspects the repository, reads files, edits code, runs tests and commands,
reads errors, and iterates until the task is done or it needs your approval.

- The **CLI** (`grace/`) is a Python package with a full-screen Textual TUI and
  a classic `grace>` prompt for non-TTY sessions.
- The **agent** (`grace/agent/`, `grace/agents/`) is a reason → act → observe
  loop with an optional coordinator/planner for complex tasks.
- **Tools** (`grace/tools/`) give the agent filesystem, search, command
  execution, git, and web access — behind safety gates (`grace/safety.py`).
- **Providers** (`grace/providers/`) are the model adapters: Groq, NVIDIA NIM,
  Gemini, MiniMax, and DeepSeek, with a fallback chain.
- The **backend** (`grace/server/`, `api/`) is a Python WSGI service (deployed
  as Vercel functions) that provides accounts, sessions, usage reporting,
  free-tier quotas, and server-side model routing against Neon PostgreSQL
  (`db/migrations/`).

The CLI works fully offline with your own `GROQ_API_KEY`; logging in
(`grace login`) adds usage reporting and access to the hosted model router.

## Project structure

```
grace/           Python package (the CLI + agent + tools + providers + server)
  agent/         The reason → act → observe agent loop
  agents/        Coordinator, planner, fast router, model router, subagents
  auth/          CLI-side authentication client and usage reporting
  cli/           Entry point, REPL, one-shot runner, slash commands
    tui/         Full-screen Textual TUI (app, store, components)
    ui/          Progress/results rendering for the classic prompt
  costs/         Money math and the centralized pricing registry
  project/       Project detection and repository indexing
  providers/     Model providers and the fallback chain
  safety/        Command policy, protected files, secret redaction
  server/        Python backend (WSGI): auth, sessions, cost guard, providers
  session/       History, subagent memory, undo snapshots
  tools/         The agent's tools (read/write/edit/search/run/git/web)
api/             Vercel Python functions (health, auth, usage, provider)
db/migrations/   Neon PostgreSQL schema (users, sessions, usage, cost ledger)
docs/            Project documentation (architecture, deployment, economics…)
tests/           pytest suite (unit, agent loop, server, TUI, CLI)
```

## Supported Python version

Grace supports **Python ≥ 3.10** (see `requires-python` in
`pyproject.toml`). CI runs the test suite on Python 3.10, 3.11, 3.12, and
3.13. Use a recent 3.12 or 3.13 for local development unless you are
specifically testing an older version.

## Development environment setup

1. **Fork and clone** the repository, then add your fork as a remote:

   ```bash
   git clone https://github.com/YOUR_GITHUB_USERNAME/grace.git
   cd grace
   git remote add upstream https://github.com/YOUR_GITHUB_USERNAME/grace.git
   ```

   (Replace `YOUR_GITHUB_USERNAME` with your actual GitHub username — the
   upstream URL is whatever the canonical repository ends up being.)

2. **Create a virtual environment** (Python ≥ 3.10):

   ```bash
   python -m venv .venv
   source .venv/bin/activate        # Windows (Git Bash): source .venv/Scripts/activate
   ```

3. **Install the project in editable mode with dev dependencies:**

   ```bash
   pip install -e ".[dev]"
   ```

   This installs the `grace` console script plus the `dev` extras (pytest).

4. **Verify the install:**

   ```bash
   grace --version
   # or, without the console script:
   python -m grace --version
   ```

5. **(Optional) Configure a provider key** so the agent can actually run
   model calls locally:

   ```bash
   echo "GROQ_API_KEY=..." > .env
   ```

   `.env` is git-ignored. Alternatively `grace register` / `grace login`
   against the backend provides hosted model access.

## Running the complete test suite

```bash
python -m pytest
```

The suite uses mocks and an in-memory database (see `tests/conftest.py` and
`tests/helpers/memory_db.py`). **No API keys and no `DATABASE_URL` are
required** — provider calls are stubbed, and the backend tests run against an
in-memory Postgres-compatible store.

Useful variants:

```bash
python -m pytest tests/test_safety.py     # a single file
python -m pytest -k "server or tui"       # keyword filter
python -m pytest -q                       # quieter output
```

## Running compile checks

```bash
python -m compileall -q grace api tests
```

This byte-compiles every module in the CLI package, the Vercel API functions,
and the tests, catching syntax errors without running anything. CI runs this
on every push.

## Running Grace locally

From the repository root, either:

```bash
python -m grace            # or the installed `grace` console script
```

Try a one-shot task:

```bash
python -m grace "Create a small Python script that prints 'hello' and a test for it"
```

Grace works on the folder you launch it from — you do not need to run it from
the Grace repository itself. Without a provider key or login, greetings,
`/help`, and `/status` still work; real agent work needs a model (a local
`GROQ_API_KEY` in `.env`, or `grace login`).

> **Safety first:** Grace is a coding agent — it reads and writes files, edits
> code, runs commands, and interacts with git. Always test it in a **safe,
> disposable development repository**, never on a project you cannot afford to
> lose or that contains secrets. See [Contributor safety](#contributor-safety).

## Running the local Python backend

The backend (`grace/server/`) is a plain WSGI app that can run locally:

```bash
python -m grace.server.serve     # serves http://localhost:8787
```

Check it:

```bash
curl http://localhost:8787/api/health
```

The backend boots without a database; add `DATABASE_URL` in `.env` (a Neon
PostgreSQL connection string) to exercise real accounts, sessions, usage
recording, and the free-tier quota locally. Point the CLI at the local backend
for end-to-end testing:

```bash
export ZEESH_API_URL=http://localhost:8787
grace register
grace login
grace whoami
```

## How the TUI is tested

The full-screen TUI (`grace/cli/tui/`) is a Textual app. It is tested
**headlessly** — no real terminal or display is needed:

- `tests/test_tui_app_keys.py` drives the **real app** through Textual's
  `run_test()` pilot with real `Key` events (typing, arrows, Ctrl+C, palette,
  overlays).
- `tests/test_tui_events.py`, `tests/test_tui_render.py`, and
  `tests/test_tui_store.py` unit-test the event pipeline, rendering, and the
  store.
- `tests/test_ui.py` covers the classic-prompt progress/results renderers.

If you change TUI behavior, add or update a test that drives the app with
`run_test()` — it catches regressions that plain component tests miss.

## Branch naming conventions

Use descriptive, hyphenated branch names with a short prefix:

| Prefix  | Use                                          | Example                          |
| ------- | -------------------------------------------- | -------------------------------- |
| `feature/` | New functionality                        | `feature/provider-ollama`        |
| `fix/`   | Bug fixes                                    | `fix/cost-guard-race`            |
| `docs/`  | Documentation only                           | `docs/tui-keybindings`           |
| `test/`  | Test-only changes                            | `test/server-provider-fallback`  |
| `chore/` | Tooling, CI, dependencies, housekeeping      | `chore/ci-python-313`            |
| `perf/`  | Performance improvements                     | `perf/context-trimming`          |

Keep names lowercase and under ~50 characters.

## Creating a feature branch

Always work on a branch — never commit directly to `main`:

```bash
git checkout -b feature/your-description
```

## Making changes

- Keep the change **focused**: one logical change per branch/PR. Do not bundle
  unrelated refactors.
- Match the existing style: Python with type hints, concise docstrings, and
  the formatting conventions already present in the files you touch.
- If your change touches a **security-sensitive area** (see below), read
  [SECURITY.md](SECURITY.md) first and expect extra scrutiny in review.
- **Never commit secrets.** Check `git status` and `git diff` before
  committing; `.env` files and API keys must never be committed.
- Do not add new runtime dependencies without discussing them in the PR —
  the dependency list is deliberately small.

## Adding tests

- New behavior should come with tests, placed in `tests/` (see the existing
  files for conventions).
- Backend tests use the fixtures in `tests/conftest.py` and
  `tests/helpers/memory_db.py` — you never need a real database or API keys.
- TUI changes: drive the app with Textual's `run_test()` pilot.
- Provider changes: use the existing stub architecture
  (`tests/test_fallback.py`, `tests/test_server_provider.py`); never require
  a real provider key in tests.

## Running tests before submitting

Before you push or open a PR, run both checks locally:

```bash
python -m pytest
python -m compileall -q grace api tests
```

Both must pass. CI runs the same checks (plus a package build) on every push
and pull request.

## Commit message guidelines

Follow [Conventional Commits](https://www.conventionalcommits.org/) with an
optional scope:

```
<type>(<scope>): <summary>

<body — why, not just what>
```

- `type`: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`,
  `security`
- `scope` (optional): the area touched, e.g. `server`, `providers`, `tui`,
  `tools`, `safety`, `costs`, `cli`
- `summary`: imperative mood, lowercase, under ~72 characters

Examples:

```
feat(providers): add Ollama provider to the registry

fix(server): reject oversized provider responses

docs: clarify free-tier session rollover behavior

test(safety): cover redaction of gsk_ secrets in command output
```

Write a short body explaining **why** the change is needed when it is not
obvious. Never include secrets or personal information in commit messages.

## Pull request process

1. Push your branch to your fork: `git push -u origin feature/your-description`
2. Open a pull request against `main` using the
   [pull request template](.github/pull_request_template.md).
3. Fill in the template: what changed, why, related issue, tests performed,
   and (for UI changes) screenshots or terminal output.
4. Reference the issue you're closing, e.g. `Closes #123`.
5. Make sure CI passes (tests + package build workflows).
6. Keep the PR small enough to review comfortably. If it grows, split it.

## Code review expectations

- Be respectful and constructive in reviews and in replies to reviews.
- Reviewers should check: correctness, test coverage for new behavior,
  security implications (see below), backward compatibility, and that no
  unrelated changes snuck in.
- If a reviewer requests changes, treat it as a conversation: respond, adjust,
  and re-request review when ready.
- Don't take requested changes personally — the goal is a solid codebase.

## Security-sensitive areas

The following areas get extra scrutiny and must be handled with care:

- **Authentication** — `grace/server/auth.py`, `grace/server/auth_service.py`,
  `grace/server/password.py`, `grace/auth/` (CLI-side). Never weaken password
  handling, session validation, or token storage.
- **Provider API keys** — `grace/providers/`, `grace/server/providers.py`.
  Keys live server-side; never log, print, or return them, and never send
  them to the CLI or browser.
- **Command execution** — `grace/tools/run_command.py`, `grace/safety.py`.
  The deny list, protected-file rules, and secret redaction are security
  boundaries.
- **Filesystem access** — `grace/tools/` file tools and protected files
  (`.env*`, `*.pem`, `*.key`, credentials).
- **Database access** — `grace/server/db.py`, `db/migrations/`. Use
  parameterized queries; never interpolate user input into SQL.
- **Sessions** — `grace/session/`, `grace/server/sessions.py`,
  `grace/server/free_sessions.py`. Session handling and quota enforcement
  must stay server-authoritative.
- **Cost controls** — `grace/costs/`, `grace/server/cost_guard.py`. The
  spending ceilings and reservations protect the project's economics.
- **Prompt/tool injection** — anything that feeds untrusted content (files,
  web content, command output) back to the model or into tool arguments.
- **Sandboxing** — anything that constrains what the agent can touch.

When in doubt, ask in the PR or open a discussion before writing code in
these areas. If you find a vulnerability, **do not open a public issue** —
follow [SECURITY.md](SECURITY.md).

## How to report bugs

Open a GitHub issue using the
[bug report template](.github/ISSUE_TEMPLATE/bug_report.md). Please include:

- Grace version (`grace --version`)
- OS and terminal
- Python version (`python --version`)
- Installation method (pip install, editable, etc.)
- Steps to reproduce
- Expected vs. actual behavior
- Logs/errors (with secrets removed)

Search existing issues first — it may already be reported.

## How to propose features

Open a GitHub issue using the
[feature request template](.github/ISSUE_TEMPLATE/feature_request.md),
covering the problem you're solving, your proposed solution, alternatives you
considered, and why it belongs in Grace. For large features, discuss the idea
before writing code — the
[roadmap](docs/roadmap.md) is a good place to see what is already planned.

## Contributor safety

Grace is a coding agent with real capabilities:

- **reads files** and **writes/edits code**
- **runs commands** in your shell (behind safety gates)
- **interacts with git** (status, diff, log; it will not push or hard-reset
  without confirmation)

Because of that:

- **Always test Grace and your changes to Grace in a safe, disposable
  development repository** — never on a project you cannot afford to lose or
  that contains credentials or sensitive data.
- The `--yes` flag auto-approves flagged commands. Never use it on a project
  you care about.
- **Never include secrets** — API keys, passwords, tokens, `.env` contents —
  in issues, pull requests, commit messages, or logs. Redact anything
  secret-shaped before pasting output.
- If a bug report involves secret material, trim it to a minimal reproduction
  with placeholders before sharing.

---

Questions? Open a discussion or ask in your pull request — we're happy to
help you get started.
