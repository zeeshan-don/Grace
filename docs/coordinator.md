# Subagent coordinator architecture (Milestone 14)

The GRACE coordinator decomposes every user task into a small plan of
**specialized agents**, runs them with narrow context and narrow permissions,
parallelizes independent work, and composes a concise final answer. This is an
original implementation inspired by the Freebuff subagent model — it copies no
source code, prompts, branding or proprietary implementation.

Goals:

- **Specialized agents** — one job per agent, tight system prompt.
- **Narrow context** — no agent ever receives the whole repository or
  conversation; only compacted, structured summaries of prior results.
- **Narrow permissions** — each agent physically can only call the tools its
  capability grant allows.
- **Coordinator-driven delegation** — the coordinator (with a small planner
  model call) decides which agents, in which order, and which run in parallel.
- **Verification after changes** — the Test Runner and Code Reviewer run after
  the Editor by default.
- **Provider/model abstraction** — agents know only `AIProvider` and a model
  tier hint; routing is pluggable.

## Roles

All role specs live in `src/agents/specs.ts`.

| Role | Capabilities | read-only | Model tier | Purpose |
| ---- | ------------ | :-------: | :--------: | ------- |
| project-scout | read | ✅ | fast | structural map of the repo (uses the maintained index) |
| file-picker | read | ✅ | fast | find + rank relevant files |
| thinker | read | ✅ | strong | deep reasoning → concise strategy |
| researcher | read, web | ✅ | default | external docs/research with URLs (`web_fetch`) |
| code-reviewer | read, diff | ✅ | strong | review changes for bugs/regressions/security/missing tests |
| test-runner | read, execute | – | default | detect framework, run only relevant tests |
| shell-runner | read, execute | – | default | run commands under the permission policy |
| git-curator | read, diff, execute | – | default | inspect/stage/commit — never pushes without authorization |
| browser-use | browser | ✅ | default | browser verification (unavailable without a backend) |
| editor | read, write, execute | – | default | the primary coding agent (the original AgentLoop) |

## Coordinator flow

`src/agents/coordinator.ts`:

```
run(task)
  1. planning event (CLI shows "· Planning…")
  2. project index get()          — structural summary, fingerprint-cached
  3. availability check           — browser-use reported unavailable
  4. planner(plan)                — LLM planner → rule-based fallback
     normalizePlan()              — cap steps, drop unknown roles,
                                    enforce editor-alone steps
  5. for each step (sequential):
       compactResults(results)    — ≤ token budget
       run agents in parallel     — bounded concurrency (default 2)
  6. bounded review→fix loop     — if the reviewer found actionable issues,
                                    the editor gets one more pass, then the
                                    test runner re-verifies (default 1 round)
  7. composeFinalAnswer()         — last editor summary first, then
                                    review + test notes, then errors
```

- Steps are **strictly ordered** (exploration → editor → verification).
- Agents **within a step run concurrently** when independent
  (e.g. test-runner + code-reviewer).
- A failed agent is recorded and **never aborts the run** — later steps still
  execute; the composed answer surfaces the failures. Even an *unexpected
  crash* (a thrown exception, not just a provider error) is caught per agent
  and marked `failed`.
- **Review → fix loop** — when the Code Reviewer returns recommendations, the
  Editor runs once more with those findings and the Test Runner re-verifies.
  Bounded to one round (`fixRounds`) so it can never loop forever.
- **Permission prompts are serialized** — parallel agents can never interleave
  two `Allow? [y/N]` prompts on the same terminal.

## Planner

`src/agents/planner.ts`:

- `llmPlanner(provider)` — one small non-streaming chat call asking for a JSON
  plan `{"steps":[{"agents":[...],"reason":"..."}]}`. Parsed defensively
  (`parsePlan`) and validated by `normalizePlan`.
- `ruleBasedPlanner(input)` — deterministic classification used when the model
  is unavailable/unparseable: test/git/research/informational/browser keyword
  routing, plus the default lifecycle
  `project-scout → file-picker → (thinker if complex) → editor →
  test-runner + code-reviewer`.

Simple tasks get few agents: `"run the tests"` → `[test-runner]`,
`"commit my changes"` → `[git-curator]`,
`"explain src/auth/session.ts"` → `[file-picker]`.

## Permissions

`src/agents/capabilities.ts` is the enforcement point:

- `toolsForCapabilities(allTools, caps)` filters the tool registry down to the
  grant — a read-only role receives no `write_file`/`edit_file`/`run_command`.
- `capabilitiesAreReadOnly()` is the defense-in-depth check the coordinator
  applies before running a spec.
- `commandPolicyForRole(role)` adds per-role rules inside `run_command`
  (`src/tools/runCommand.ts`):
  - **test-runner**: `npm test`, `npm run typecheck/build/lint`, `pytest`,
    `go test`, `node --test`, … run without asking.
  - **git-curator**: `git add`/`commit`/`rm`/`mv`/`restore`/`stash`/`tag`/
    `clean` **always require user approval**, even though they are not in the
    danger policy. `git push` stays behind the danger gate (user approval
    required) and the prompt forbids pushing without explicit authorization.

The existing danger policy (`src/safety/policy.ts`) still applies to every
agent's `run_command`.

## Context management

- Each agent receives: role system prompt + the task + a compacted context
  block (`Index:\n…` + prior results rendered by `compactResults`).
- `src/agents/compact.ts`: summaries are truncated, findings capped, and the
  oldest results dropped first when the token budget (default 4 000) is
  exceeded. Deterministic — safe for tests.
- Subagent conversations live in a `MemorySession`
  (`src/session/memory.ts`) — never written to `.zeesh/session.json`. Only the
  Editor persists into the user's real session history.
- Structured results (`src/agents/structured.ts`): most agents end with one
  JSON object `{summary, files, findings, recommendations}`; parsing is
  best-effort with a plain-text fallback.

## Project index

`src/project/index.ts` — a lightweight, maintained repository index:

- `ProjectIndexService.get()` returns a structural summary (type, PM,
  languages, entrypoints, test/build commands, test framework, top-level
  layout, key files, important symbols).
- A cheap **fingerprint** (files/dirs up to depth 3 + `package.json` contents)
  detects changes; the index is rebuilt lazily when it changes and the
  coordinator invalidates it after the Editor runs.
- The planner and repo-aware agents (scout, picker, thinker, editor) receive
  the compact summary instead of a repository dump.

## Model routing

`src/agents/modelRouter.ts`. Every spec carries a `modelTier`
(`fast`/`default`/`strong`). A route resolves to `{ provider, model }`
(`ModelRoute`). Today all agents share the configured provider and model; the
coordinator consults the router through a pluggable
`providerFactory(role, spec)`. To split models later (file-picker → fast
model, thinker → strongest model), replace the factory/router — no agent code
changes. `ZEESH_AGENT_MODEL` overrides the model for all roles and
`ZEESH_PROVIDER` overrides the provider id (diagnostics/ops).

The same abstraction drives the **server-side router**: the GRACE API's
`/api/provider` builds its chain from `SERVER_ROUTING_PREFERENCE` (`nvidia`
primary → `groq` fallback), each provider included only when its server-side
key is configured. Fallback happens at the model-request boundary before any
response is consumed, so it can never duplicate a tool execution — see
`src/providers/fallback.ts` and `docs/api.md`.

## CLI UX

`src/cli/taskRunner.ts` wires the coordinator into both the REPL and one-shot
mode:

```
· Planning…
  → Project Scout
  → File Picker
  → Editor
  → Test Runner
  → Code Reviewer
· Done

<composed final answer>

Changed files: …
3 iteration(s) · 5 tool call(s) · 42s
Session 1 / 6 · 41m 12s left · 12m / 6h used today
```

Only progress lines and summaries are shown — never agent chain-of-thought.
The final answer, changed files, run stats, GRACE FREE quota line and usage
reporting are identical in shape to the pre-coordinator CLI. Slash commands,
the banner, and `/status` are unchanged.

## Failure modes

| Failure | Behavior |
| ------- | -------- |
| planner model call fails | rule-based fallback plan |
| an agent's provider call fails | agent marked `failed`, run continues |
| an agent crashes unexpectedly | caught per agent, marked `failed`, run continues |
| read-only role granted mutating tools | coordinator refuses (defense in depth) |
| browser-use planned but no backend | agent reported `unavailable` with reason |
| coordinator throws unexpectedly | the REPL reports the error and returns to the prompt |

## Tests

`tests/coordinator.test.ts` — routing, minimal-agent selection, sequential and
parallel delegation, failure recovery, editor modifications, read-only
boundaries, browser unavailability, usage aggregation.
`tests/agents.test.ts` — capability grants, command policies, structured
parsing, context compaction, memory sessions.
`tests/projectIndex.test.ts` — build/cache/fingerprint invalidation.
`tests/cli.coordinator.test.ts` — CLI E2E progress UX in one-shot and
interactive modes.
