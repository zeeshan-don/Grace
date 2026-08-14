# Grace coordinator architecture (primary-agent redesign)

GRACE is built around **one primary agent** that handles the task end to end —
it understands the request, searches the repository, reads files, edits code,
runs commands, fixes errors and iterates until the task is done. Planning and
specialized subagents are **optional**: they are only engaged for complex tasks
or when the user explicitly asks.

```
User request
   │
   ▼
Fast local router (deterministic — NO model call)
   │
   ├── conversation → local reply (0 LLM calls, 0 tools)
   ├── tests        → deterministic test runner (0 LLM calls)
   │
   └── coding / inspect / complex
         │
         ▼
   ┌─────────────────────────────┐
   │  Primary Agent (default)    │  one agent loop
   │  search → read → edit/write │  full read/write/execute toolset
   │  run commands → fix → re-run│
   └─────────────────────────────┘
         │
         ▼
   complex tasks only: optional planning phase
   (thinker strategy specialist may run first)
   │
   ▼
   composed final answer · changed files · validation · stats
```

The philosophy: *Grace should feel like one intelligent, fast coding agent
with powerful tools — not a slow committee meeting of six AI agents.*

## Fast local router

`src/agents/fastRouter.ts` classifies every input with deterministic regex
logic before any model call — no LLM is spent deciding which LLM should run.

| Input | Route | Behavior |
| ----- | ----- | -------- |
| `hi`, `thanks`, `what can you do?` | conversation | local reply, instant, no provider needed |
| `run the tests` | tests | deterministic test runner, no LLM |
| `build authentication`, `refactor the architecture` | complex | optional planning + primary agent |
| `explain package.json`, `what does this file do?` | inspect | primary agent (reads, doesn't edit) |
| everything else | coding | primary agent immediately |

Browser-verification requests ("why does this website look broken") route to
`complex` so the optional browser specialist can report availability.

## Coordinator flow

`src/agents/coordinator.ts`:

```
run(task)
  1. route = classifyTask(task)         — fast local router, no model call
  2. conversation  → local reply        — 0 LLM calls, 0 tools, 0 repo scan
     tests         → deterministic runner — 0 LLM calls
  3. complex tasks only:
       planning event (CLI shows "· Planning…")
       planner      — LLM planner (reasoning tier) → rule-based fallback,
                      or an injected plan (tests)
       normalizePlan — cap steps, drop unknown roles, editor runs alone
  4. execute plan:
       coding/inspect → DEFAULT_PRIMARY_PLAN = one step: [editor]
       complex        → optional specialist steps (e.g. thinker) then editor
       each step: compactResults(results) → run agents (bounded concurrency)
  5. bounded review→fix loop — dormant by default (only when a reviewer ran
      with actionable findings)
  6. composeFinalAnswer() — the primary agent's summary, plus review/test
      notes when present
```

- The **primary agent is the default execution path** — simple and medium
  tasks run exactly one agent loop.
- Specialist subagents **only run when a complex plan includes them**
  (e.g. `thinker` for architecture strategy, `researcher` for web research,
  `browser-use` for browser verification).
- A failed agent is recorded and **never aborts the run**; even an unexpected
  crash is caught per agent and marked `failed`.
- **Permission prompts are serialized** so parallel specialists can never
  interleave two prompts on the same terminal.

## Roles

All role specs live in `src/agents/specs.ts`. The **editor is Grace — the
primary agent** with the full read/write/execute toolset. The others are
**optional specialists** that only appear when a complex plan includes them:

| Role | Capabilities | read-only | Purpose |
| ---- | ------------ | :-------: | ------- |
| **editor (Grace)** | read, write, execute | – | the primary agent — handles the task end to end |
| project-scout | read | ✅ | structural map of the repo (uses the maintained index) |
| file-picker | read | ✅ | find + rank relevant files |
| thinker | read | ✅ | deep reasoning → concise strategy (complex plans) |
| researcher | read, web | ✅ | external docs/research with URLs (`web_fetch`) |
| code-reviewer | read, diff | ✅ | review changes (only when explicitly planned/requested) |
| test-runner | read, execute | – | deterministic — runs tests with no LLM |
| shell-runner | read, execute | – | run commands under the permission policy |
| git-curator | read, diff, execute | – | inspect/stage/commit — never pushes without authorization |
| browser-use | browser | ✅ | browser verification (unavailable without a backend) |

## Planner (optional, complex tasks only)

`src/agents/planner.ts`:

- `llmPlanner(provider)` — one small non-streaming chat call asking for a JSON
  plan, parsed defensively (`parsePlan`) and validated by `normalizePlan`.
  Falls back to the rules on any failure. The planning call's token usage is
  captured into the run's total — no internal model call is ever omitted.
- `ruleBasedPlanner(input)` — deterministic plan used by default and on LLM
  failure. Deliberately lean: test/git/research/browser keyword routing, and
  complex tasks get `thinker → editor` (strategy specialist + primary agent).
  **No** scouts, pickers or reviewers run automatically.

Simple tasks never plan: `"fix the login bug"` → `[editor]` (one agent),
`"run the tests"` → `[test-runner]` (deterministic),
`"commit my changes"` → `[git-curator]`.

## Permissions & smart validation

`src/agents/capabilities.ts` is the enforcement point:

- `toolsForCapabilities(allTools, caps)` filters the tool registry down to the
  grant — a read-only role receives no `write_file`/`edit_file`/`run_command`.
- `commandPolicyForRole(role)` adds per-role rules inside `run_command`:
  - **editor (Grace) + test-runner**: `npm test`, `npm run typecheck/build`,
    `pytest`, `go test`, `node --test`, … run without asking — so the primary
    agent validates proportional to the change (a typo needs no test run; a
    code change runs the relevant typecheck/tests) without interrupting the
    user. Danger-flagged commands still prompt.
  - **git-curator**: `git add`/`commit`/`rm`/`mv`/`restore`/`stash`/`tag`/
    `clean` always require user approval.

The existing danger policy (`src/safety/policy.ts`) still applies to every
agent's `run_command`, and now also flags **dependency installation**
(`pip install`, `npm install <pkg>`, `poetry add`, `cargo add`, …) so the agent
must ask before adding a framework it cannot find. `run_command` also caps its
runtime at 300s — a long-running server command can never hang the agent.

## Context management

- The primary agent receives: its system prompt + the task + a compact
  `Index:` summary (the repository index) + compacted prior results — never
  the whole repository or conversation.
- `src/agents/compact.ts`: summaries are truncated, findings capped, and the
  oldest results dropped first when the token budget (default 4 000) is
  exceeded. Deterministic — safe for tests.
- The primary agent persists into the user's real session history
  (`src/session/session.ts`); subagent conversations live in a throwaway
  `MemorySession` — never written to `.zeesh/session.json`.
- `src/agent/context.ts` trims the conversation window and truncates oversized
  tool results so the working context stays compact.
- `src/agent/toolCache.ts` dedupes repeated `read_file` / `list_directory` /
  `search_files` calls within a run: reads re-validate against mtime+size,
  listings against the mutation epoch + dir mtime, and any write/edit/run
  command invalidates the search cache — repeated identical calls never
  re-scan the repo, but an edited file is never served stale.
- The editor prompt (and the repository index summary) tell the agent to
  identify the application (entry points, framework, dependency files, test
  setup) from the Index BEFORE editing anything, and never to assume a file
  is the app entry point because of its name.

## Project index

`src/project/index.ts` — a lightweight, maintained repository index:

- `ProjectIndexService.get()` returns a structural summary (type, PM,
  languages, entrypoints, test/build commands, test framework, top-level
  layout, key files, important symbols).
- A cheap **fingerprint** detects changes; the index is rebuilt lazily and the
  coordinator invalidates it after the primary agent edits files.
- The primary agent receives the compact summary instead of a repository dump,
  and uses `search_files`/`read_file` for anything task-specific.

## Model & provider routing

- The **primary agent uses the user's configured provider/model directly** —
  one visible provider (`Grace · NVIDIA · qwen/…` in the CLI), no per-agent
  model switching. Fallback stays automatic: the server-side router retries
  NVIDIA → Groq at the model-request boundary, and the client loop retries
  rate limits with bounded backoff.
- Optional specialists resolve their own route through
  `src/agents/modelRouter.ts` (`fast`/`coding`/`reasoning`/`review` tiers);
  the optional planning call uses the `reasoning` tier.
- The provider abstraction (`src/providers/types.ts` `AIProvider`) makes
  adding a provider a registry + env change — no agent code changes.
  **DeepSeek is implemented and registered** (`src/providers/deepseek.ts`,
  OpenAI-compatible, `DEEPSEEK_API_KEY` server-side); wiring it into the
  server chain is a one-line change to `SERVER_ROUTING_PREFERENCE`.

## CLI UX

`src/cli/taskRunner.ts` wires the coordinator into both the REPL and one-shot
mode. The progress renderer (`src/cli/ui/progress.ts`) shows states, not a
committee:

```
· Grace is working…
• → read_file src/auth/login.ts
• → edit_file src/auth/login.ts
• → run_command npm test
→ Grace ✓ — Authentication added
```

- Greetings render nothing and are answered directly (`Hey. What are we
  building?`) — even without a provider configured.
- Only high-level state is shown: working, exploring (tool bullets), running
  commands, done. Never chain-of-thought. Internal agent names (thinker,
  reviewer, …) and the provider/model header are debug-only (`/debug`).
- The final block shows the composed answer, changed files (`Updated:`),
  validation and a compact footer (`12.4s · 5 tool calls`). Provider/model,
  iterations, LLM-call count and token usage live in `/status` and debug mode
  — never repeated after every task.

## Instrumentation

Every run records (in `CoordinatorRunResult.metrics`): total **LLM calls**
(across the primary agent, optional specialists AND the optional planning
call), wall-clock **duration**, **tool calls**, **duplicate tool calls**
(served from the dedup cache), **failed tool calls**, model **retries**, and
**model wait / tool exec** time. The CLI prints a concise metrics footer after
each task (`1m 52s · 8 tool calls · 11 LLM calls`, plus a dim line for
duplicates/failures/retries when present) and the full breakdown in verbose
mode. The run's token usage aggregates every internal model call and is
reported server-side (`/api/usage`) when logged in. Internal chain-of-thought
is never exposed.

## Failure modes

| Failure | Behavior |
| ------- | -------- |
| greeting / tests | handled locally — no provider involved |
| complex planner model call fails | rule-based fallback plan |
| an agent's provider call fails | agent marked `failed` with a classified category |
| an agent crashes unexpectedly | caught per agent, marked `failed`, run continues |
| read-only role granted mutating tools | coordinator refuses (defense in depth) |
| browser-use planned but no backend | agent reported `unavailable` with reason |
| coordinator throws unexpectedly | the REPL reports the error and returns to the prompt |

## Classified run errors (agent loop)

`src/agent/errors.ts` classifies every loop failure so the UI reports the
ACTUAL failure instead of blaming the provider:

- `provider_unavailable` / `provider_timeout` / `provider_authentication` —
  real provider problems (the message keeps the "I could not reach the AI
  provider" prefix).
- `invalid_tool_call` — tool-call arguments could not be parsed as JSON.
  `src/agent/toolCall.ts` validates arguments before execution, applies only
  conservative repairs (code fences / a single complete JSON object), and
  sanitizes assistant messages so malformed arguments never reach the
  provider's wire format. When the provider itself rejects a streamed tool
  call (Groq: "Failed to parse tool call arguments as JSON"), the loop
  retries via the provider's structured non-streaming path and classifies a
  persistent failure as `invalid_tool_call` — never "provider unreachable".
  Two consecutive turns where no tool executed also fail fast with this
  category instead of thrashing to the iteration cap.
- `tool_execution` / `task_cancelled` — tool crashes and Ctrl+C.

## Tests

`tests/coordinator.test.ts` — fast-router classification, conversation (0 LLM
calls), deterministic test runs, single-agent default, complex planning +
optional specialists, failure recovery, editor modifications, read-only
boundaries, browser unavailability, usage aggregation + metrics.
`tests/agents.test.ts` — capability grants, command policies, structured
parsing, context compaction, memory sessions.
`tests/projectIndex.test.ts` — build/cache/fingerprint invalidation.
`tests/cli.coordinator.test.ts` — CLI E2E: a simple task runs the primary
agent only (no planner/scout/picker/reviewer), greetings make zero provider
calls, interactive flow returns to the prompt.
