# Roadmap

This is a living document. It describes where Grace is today and the
directions we want to take it. **Nothing here is a promise or a date** — the
roadmap changes as the project, its users, and its contributors evolve.
Community contributions are welcome: if something below interests you, open
an issue or a pull request and discuss it with the maintainers first.

## Current

What exists today and is actively maintained:

- A working local agent: CLI (REPL + one-shot runs), full-screen Textual TUI,
  and a classic prompt fallback for non-TTY sessions.
- Core agent loop with repository indexing, context management, undo, and a
  deterministic fast router (conversation, tests, and coding routes).
- Tools with a safety layer: file read/write/edit/search, command execution
  behind a deny list, protected-file rules, secret redaction, git diff, and
  web fetch.
- Five real providers (Groq, NVIDIA NIM, Gemini, MiniMax, DeepSeek) with a
  fallback chain and a centralized pricing registry.
- A Python backend (WSGI, Vercel-ready) with real accounts and sessions,
  usage reporting, a server-side free-tier quota (3 sessions/day × 60 min),
  and an internal cost guard with race-safe reservations.
- A pytest suite (~200 tests) that runs with mocks and an in-memory database
  — no API keys required.
- An open-source contributor workflow (CONTRIBUTING, issue/PR templates, CI,
  CODEOWNERS) — this is new and needs real contributors to exercise it.

## Near-term

Plausible next steps, in rough priority order:

- **Agent reliability** — better error recovery, clearer iteration limits,
  and fewer cases where the agent needs a human nudge.
- **Better codebase context** — smarter repository indexing and
  summarization so the agent understands larger projects without blowing up
  the context window.
- **TUI polish** — keyboard-first improvements, better permission dialogs,
  and streaming output rendering.
- **More provider integrations** — additional providers behind the existing
  `AIProvider` contract (the registry + env design makes this low-risk).
- **Testing** — more coverage for the agent loop and coordinator, plus
  cross-platform (Windows/macOS) CI if the project gains Windows-using
  maintainers.
- **Security and sandboxing** — optional sandboxing/containerization for
  command execution, and hardening of prompt/tool injection boundaries.
- **Performance** — faster startup, leaner context management, and reduced
  token usage per run.

## Future

Longer-horizon ideas, deliberately vague:

- **Economics** — Grace's stated model is free AI coding funded by
  developer-focused advertising. Measuring real per-user cost (the
  groundwork is in place) comes before any advertising work, and ads must
  never see user code or data.
- **Contributor ecosystem** — subsystem maintainers, a public
  discussions/community channel, and a formal governance model as
  contributors arrive.
- **Backend deployment** — actually deploying the Vercel backend and Neon
  database once credentials and economics are in place.
- **Deeper agent capabilities** — multi-repository workflows, long-running
  background tasks, and richer IDE/editor integrations.
- **Documentation** — a proper docs site, tutorials, and a "how the agent
  works" guide for newcomers.

## How to influence the roadmap

- Open an issue using the [feature request template](../.github/ISSUE_TEMPLATE/feature_request.md)
  or the [documentation template](../.github/ISSUE_TEMPLATE/documentation.md).
- Comment on existing roadmap issues to signal interest.
- Best of all: contribute. See [CONTRIBUTING.md](../CONTRIBUTING.md) — a
  working pull request is the strongest vote for an idea.

The roadmap is maintained by the maintainers but shaped by the community.
It can and will change.
