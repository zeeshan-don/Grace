# Security Policy

Grace is a coding agent with real capabilities — it reads and writes files,
edits code, runs commands, and interacts with git. The security of users'
code, credentials, and data matters. This policy explains how to report
vulnerabilities responsibly.

## Supported versions

The project is pre-1.0. Security fixes are applied to the `main` branch and
to the latest tagged release. If you depend on Grace, prefer running the
latest release or `main`.

## Reporting a vulnerability

**Do NOT report security vulnerabilities publicly in GitHub Issues, pull
requests, or discussions.** Public disclosure of a vulnerability before it is
fixed can put users at risk.

Please report vulnerabilities **privately**:

1. **Preferred:** use GitHub **private vulnerability reporting** — open the
   repository's **Security** tab and choose **Report a vulnerability**. This
   creates a private advisory only maintainers can see.
2. **Fallback (placeholder):** if private vulnerability reporting is not
   enabled for the repository, email the maintainers at
   `security@example.com` — **replace this address with the maintainer's real
   security contact before publishing this file.**

You will receive an acknowledgement, typically within 72 hours, and we will
keep you informed of progress toward a fix. Please do not disclose the issue
publicly until we have released a fix or agreed on a disclosure timeline.

## What a security report should contain

To help us triage quickly, include:

- **Affected component** — e.g. CLI, agent, tools, providers, backend, auth,
  database, Vercel API.
- **Grace version** (`grace --version`) and how it was installed.
- **Environment** — OS, Python version, terminal, and whether the backend
  (`grace/server`) is involved.
- **Description** — what the vulnerability is and how it can be exploited.
- **Steps to reproduce** — a minimal, self-contained reproduction.
- **Impact** — what an attacker could do (data exposure, code execution,
  privilege escalation, cost abuse, etc.).
- **Suggested fix** (optional) — a patch or mitigation idea.

Do **not** include live secrets in the report (real API keys, passwords,
session tokens, database credentials). Use redacted examples or placeholders.

## Sensitive areas in Grace

When reporting (or fixing) vulnerabilities, the areas most likely to matter are:

- **Authentication** — account registration/login, password hashing
  (`grace/server/password.py`), session token handling (`grace/server/sessions.py`).
- **Provider API keys** — server-side keys (`grace/server/providers.py`,
  `grace/providers/`) must never leak to the CLI, browser, logs, or errors.
- **Command execution** — `grace/tools/run_command.py` and the safety policy
  in `grace/safety.py` (deny list, protected files, secret redaction).
- **Filesystem access** — the file tools and the protected-file rules
  (`.env*`, `*.pem`, `*.key`, credentials, SSH keys).
- **Database access** — `grace/server/db.py` and `db/migrations/`; SQL
  injection, privilege separation, and credential handling.
- **Sessions** — CLI sessions (`grace/session/`) and server-side sessions and
  free-tier quotas (`grace/server/free_sessions.py`) must stay
  server-authoritative.
- **Cost controls** — `grace/costs/` and `grace/server/cost_guard.py` (the
  spending ceilings, reservations, and circuit breakers).
- **Prompt/tool injection** — untrusted content (files, web content, command
  output) influencing model prompts or tool arguments.
- **Sandboxing** — any mechanism constraining what the agent can read, write,
  or execute.

## Handling of reports

- We acknowledge reports promptly (typically within 72 hours).
- We investigate, reproduce, and prepare a fix, keeping you informed.
- We coordinate disclosure: you may publish after a fix is released or after
  we agree on a timeline.
- We credit reporters in release notes or advisories when the reporter
  consents.

## Security hygiene for contributors

- **Never commit secrets.** `.env` files and API keys must never reach the
  repository, issues, pull requests, or commit messages.
- Test Grace — and your changes to Grace — in a **safe, disposable
  development repository**, never a project containing credentials or data
  you cannot afford to lose.
- See [CONTRIBUTING.md](CONTRIBUTING.md) for contributor expectations and the
  [Code of Conduct](CODE_OF_CONDUCT.md) for community standards.
