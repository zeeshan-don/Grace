"""The GRACE coordinator (port of src/agents/coordinator.ts).

Primary-agent architecture:

    User request
       ↓
    Fast local router (deterministic — no model call)
       ↓
    conversation → local reply (0 LLM calls)   tests → deterministic runner (0 LLM calls)
       ↓
    Primary Agent (default) ← optional planning for complex tasks
       ↓
    Tools: search → read → edit/write → run commands → fix errors → repeat

The primary agent (editor) is the default execution path. Specialist
subagents only run when a complex plan explicitly includes them; the
coordinator stays the orchestrator and composes the final answer from the
agent results.
"""

import time

from grace.agent.loop import TaskCancelledError
from grace.agents.browser import browser_availability
from grace.agents.capabilities import capabilities_are_read_only, command_policy_for_role, tools_for_capabilities
from grace.agents.compact import compact_results, compact_text
from grace.agents.fast_router import classify_task, conversation_reply
from grace.agents.planner import DEFAULT_PRIMARY_PLAN, llm_planner, normalize_plan, rule_based_planner
from grace.agents.specs import AGENT_SPECS, ALL_AGENT_ROLES
from grace.agents.subagent import run_subagent
from grace.agents.test_runner import run_deterministic_test_runner
from grace.agents.types import AgentPlan, CoordinatorRunResult, PlanStep, SubagentResult
from grace.project.index import ProjectIndexService
from grace.session.memory import MemorySession
from grace.tools.registry import ToolContext, create_tools

DEFAULT_CONCURRENCY = 2
DEFAULT_RESULT_BUDGET = 4_000

# Roles that receive the compact repository index so they never re-scan the
# whole repository.
INDEX_AWARE_ROLES = ("editor", "thinker", "project-scout")


class TrackedProvider:
    """Wrap a provider so every successful chat call reports its usage and
    counts one LLM call (used to capture the optional planning call's tokens —
    no internal model call is ever omitted from the run's usage)."""

    def __init__(self, base, on_result, on_call) -> None:
        self._base = base
        self._on_result = on_result
        self._on_call = on_call

    def __getattr__(self, name):
        return getattr(self._base, name)

    def chat(self, messages, options=None):
        self._on_call()
        res = self._base.chat(messages, options)
        self._on_result(res)
        return res

    def stream_chat(self, messages, options=None):
        return self._base.stream_chat(messages, options)


class Coordinator:
    """Orchestrates a task run: routes, plans (complex only), delegates to
    subagents, folds results, and composes the user-facing final answer."""

    def __init__(self, deps: dict) -> None:
        self.deps = deps
        self.runtime = deps["runtime"]
        self.index = deps.get("projectIndex") or ProjectIndexService(self.runtime.root)
        # Serializes user permission prompts so parallel agents never interleave.
        self.ask_queue: list = []

    # -------------------------------------------------------------------------
    # Run
    # -------------------------------------------------------------------------

    def run(self, task: str) -> CoordinatorRunResult:
        started_at = time.monotonic() * 1000
        clock: dict = {"startedAt": started_at}
        on_event = self.deps.get("onEvent")

        def emit(e: dict) -> None:
            if e.get("type") == "status":
                if clock.get("firstStatusAt") is None:
                    clock["firstStatusAt"] = time.monotonic() * 1000
                if clock.get("firstToolAt") is None and e.get("message", "").strip().startswith("→"):
                    clock["firstToolAt"] = time.monotonic() * 1000
            if on_event:
                on_event(e)

        route = classify_task(task)
        emit({"type": "route", "route": route})

        # Conversational input: answered locally — zero model calls, zero tools,
        # zero repository scanning.
        if route == "conversation":
            emit({"type": "done"})
            return CoordinatorRunResult(
                task=task,
                route=route,
                plan=AgentPlan(steps=[], notes="conversation"),
                results=[],
                finalAnswer=conversation_reply(task),
                changedFiles=[],
                iterations=0,
                toolCalls=0,
                usage=None,
                metrics={"llmCalls": 0},
            )

        # Test runs: the deterministic runner — zero model calls.
        if route == "tests":
            return self.run_tests(task, emit)

        runtime = self.runtime
        index = self.index.get()
        browser = browser_availability()
        unavailable: list[str] = [] if browser["available"] else ["browser-use"]
        available = [r for r in ALL_AGENT_ROLES if r not in unavailable]

        # Planning is optional and reserved for complex tasks. Everything else
        # starts the primary agent immediately.
        self.throw_if_aborted()
        plan: AgentPlan
        planner_calls = 0
        planner_usage = None
        if route == "complex":
            emit({"type": "planning"})

            def on_call():
                nonlocal planner_calls
                planner_calls += 1

            def on_result(res):
                nonlocal planner_usage
                planner_usage = res.usage

            plan = self.resolve_plan(task, index.summary, available, unavailable, on_call, on_result)
        else:
            plan = DEFAULT_PRIMARY_PLAN
        self.throw_if_aborted()

        acc: dict = {"changedFiles": set(), "iterations": 0, "toolCalls": 0, "inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
        self._merge_usage(acc, planner_usage)
        results: list[SubagentResult] = []

        for s, step in enumerate(plan.steps):
            self.throw_if_aborted()
            emit({"type": "step-start", "step": s + 1, "total": len(plan.steps)})
            # Narrow context: compacted summaries of prior steps + the
            # repository index — never raw tool dumps or full conversations.
            context_text = compact_results(results, self.deps.get("resultTokenBudget") or DEFAULT_RESULT_BUDGET)
            step_results = self.run_step(step.agents, task, context_text, index.summary, unavailable, emit)
            self.merge(acc, results, step_results)

        # Bounded review→fix loop: only when a reviewer actually ran with
        # actionable findings (never by default — review stays optional).
        fix_rounds = self.deps.get("fixRounds", 1)
        for _round in range(fix_rounds):
            reviewer = next((r for r in results if r.agent == "code-reviewer" and r.status == "completed"), None)
            editor_ran = any(r.agent == "editor" for r in results)
            needs_fix = editor_ran and reviewer is not None and len(reviewer.recommendations) > 0
            if not needs_fix:
                break
            context_text = compact_results(results, self.deps.get("resultTokenBudget") or DEFAULT_RESULT_BUDGET)
            step_results = self.run_step(["editor"], f"{task}\n\nAddress the review findings above.", context_text, index.summary, unavailable, emit)
            self.merge(acc, results, step_results)
            test_planned = any("test-runner" in s.agents for s in plan.steps)
            if test_planned:
                verify_ctx = compact_results(results, self.deps.get("resultTokenBudget") or DEFAULT_RESULT_BUDGET)
                step_results = self.run_step(["test-runner"], f"{task}\n\nRe-run the relevant tests after the fix.", verify_ctx, index.summary, unavailable, emit)
                self.merge(acc, results, step_results)

        final_answer = compose_final_answer(results, unavailable)
        emit({"type": "done"})

        usage = None
        if acc["totalTokens"] > 0:
            usage = {"inputTokens": acc["inputTokens"], "outputTokens": acc["outputTokens"], "totalTokens": acc["totalTokens"]}

        return CoordinatorRunResult(
            task=task,
            route=route,
            plan=plan,
            results=results,
            finalAnswer=final_answer,
            changedFiles=sorted(acc["changedFiles"]),
            iterations=acc["iterations"],
            toolCalls=acc["toolCalls"],
            usage=usage,
            metrics=self.build_metrics(clock, acc, results, planner_calls),
        )

    # -------------------------------------------------------------------------
    # Paths that never touch a model
    # -------------------------------------------------------------------------

    def run_tests(self, task: str, emit) -> CoordinatorRunResult:
        spec = AGENT_SPECS["test-runner"]
        emit({"type": "agent-start", "role": "test-runner", "label": spec.label})
        result = run_deterministic_test_runner(self.runtime.root, self.runtime.project)
        emit({
            "type": "agent-done",
            "role": "test-runner",
            "label": spec.label,
            "status": result.status,
            "summary": result.summary,
            "error": result.error,
        })
        emit({"type": "done"})
        return CoordinatorRunResult(
            task=task,
            route="tests",
            plan=AgentPlan(steps=[PlanStep(agents=["test-runner"], reason="Run the tests.")]),
            results=[result],
            finalAnswer=compose_final_answer([result], []),
            changedFiles=[],
            iterations=0,
            toolCalls=0,
            usage=None,
            metrics={"llmCalls": 0},
        )

    # -------------------------------------------------------------------------
    # Optional planning (complex tasks only)
    # -------------------------------------------------------------------------

    def resolve_plan(self, task: str, index_summary: str, available: list[str], unavailable: list[str], on_call, on_result) -> AgentPlan:
        """Injected planner (tests) wins; otherwise the LLM planner runs and
        falls back to the deterministic rule-based planner. The planning call's
        usage is captured so no internal model call is omitted from the total."""
        if self.deps.get("planner"):
            return normalize_plan(self.deps["planner"](self._planner_input(task, index_summary, available, unavailable)), ALL_AGENT_ROLES)
        provider = self.deps.get("plannerProvider")
        if provider is None:
            provider = self.runtime.provider
        tracked = TrackedProvider(provider, on_result, on_call) if provider else None
        return llm_planner(tracked)(self._planner_input(task, index_summary, available, unavailable))

    def _planner_input(self, task: str, index_summary: str, available: list[str], unavailable: list[str]):
        class _Input:
            pass

        inp = _Input()
        inp.task = task
        inp.indexSummary = index_summary
        inp.availableAgents = available
        inp.unavailableAgents = unavailable
        return inp

    # -------------------------------------------------------------------------
    # Plan execution
    # -------------------------------------------------------------------------

    def merge(self, acc: dict, results: list, step_results: list[SubagentResult]) -> None:
        for r in step_results:
            results.append(r)
            acc["iterations"] += r.iterations
            acc["toolCalls"] += r.toolCalls
            self._merge_usage(acc, r.usage)
            # Only agents that actually hold the write capability can have
            # changed files — a read-only agent's spurious/attempted write must
            # never show up in the final "Changed files:" list.
            spec = AGENT_SPECS[r.agent]
            if "write" in spec.capabilities:
                for f in r.changedFiles:
                    acc["changedFiles"].add(f)

    @staticmethod
    def _merge_usage(acc: dict, usage) -> None:
        if not usage:
            return
        # SubagentResult.usage arrives as a dict (the loop's usage record); the
        # planner path passes a Usage object. Accept both.
        if isinstance(usage, dict):
            input_tokens = usage.get("inputTokens", 0)
            output_tokens = usage.get("outputTokens", 0)
            total_tokens = usage.get("totalTokens", 0)
        else:
            input_tokens = usage.inputTokens
            output_tokens = usage.outputTokens
            total_tokens = usage.totalTokens
        acc["inputTokens"] += input_tokens
        acc["outputTokens"] += output_tokens
        acc["totalTokens"] += total_tokens

    def run_step(self, roles: list[str], task: str, context_text: str, index_summary: str, unavailable: list[str], emit) -> list[SubagentResult]:
        """One plan step: independent agents in parallel, bounded concurrency."""
        cap = max(1, min(self.deps.get("maxConcurrency") or DEFAULT_CONCURRENCY, len(roles)))
        out: list[SubagentResult | None] = [None] * len(roles)
        next_idx = 0

        def worker() -> None:
            nonlocal next_idx
            while next_idx < len(roles):
                i = next_idx
                next_idx += 1
                out[i] = self.run_one(roles[i], task, context_text, index_summary, unavailable, emit)

        import threading

        threads = [threading.Thread(target=worker) for _ in range(cap)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        return [r for r in out if r is not None]

    def run_one(self, role: str, task: str, context_text: str, index_summary: str, unavailable: list[str], emit) -> SubagentResult:
        runtime = self.runtime
        spec = AGENT_SPECS[role]

        emit({"type": "agent-start", "role": role, "label": spec.label})
        if role == "editor":
            emit({"type": "working"})

        # Unavailable roles (browser-use without a browser backend) are
        # reported cleanly instead of silently doing nothing.
        if role in unavailable:
            reason = browser_availability()["reason"] or "not available"
            res = SubagentResult(
                agent=role,
                label=spec.label,
                status="unavailable",
                summary=f"Browser verification is unavailable: {reason}",
                error=reason,
                iterations=0,
                toolCalls=0,
            )
            emit({"type": "agent-done", "role": role, "label": spec.label, "status": "unavailable", "summary": res.summary, "error": reason})
            return res

        # Defense in depth: a read-only spec must never carry write/execute tools.
        if spec.readOnly and not capabilities_are_read_only(spec.capabilities):
            return self.fail(spec, "Permission boundary violation: read-only role granted mutating tools.", emit)

        # NO_LLM roles (e.g. the test runner) run deterministically — no model
        # request is consumed and no provider is built.
        if spec.modelTier == "no_llm":
            return self.run_no_llm(role, spec, emit)

        try:
            provider = runtime.provider
            factory = self.deps.get("providerFactory")
            if factory:
                provider = factory(role, spec) or provider
            if provider is None:
                return self.fail(spec, "No AI provider is configured.", emit)

            session = runtime.session if role == "editor" else MemorySession()
            ctx = ToolContext(
                projectRoot=runtime.root,
                askPermission=self.serialized_ask,
                commandPolicy=command_policy_for_role(role),
                undo=runtime.undo,
            )
            tools = tools_for_capabilities(create_tools(ctx), spec.capabilities)

            # Repo-aware roles receive the compact index summary so they never
            # re-scan the whole repository.
            if role in INDEX_AWARE_ROLES:
                context = f"Index:\n{compact_text(index_summary, 2_000)}\n\n{context_text}"
            else:
                context = context_text

            result = run_subagent(
                {
                    "provider": provider,
                    "tools": tools,
                    "projectRoot": runtime.root,
                    "project": runtime.project,
                    "session": session,
                    "undo": runtime.undo,
                    "askPermission": self.serialized_ask,
                    "onStatus": lambda msg: emit({"type": "status", "message": msg}),
                    "onToolEvent": lambda e: self._emit_tool_event(emit, e),
                    "signal": self.deps.get("signal"),
                },
                spec,
                task,
                context,
            )

            emit({"type": "agent-done", "role": role, "label": spec.label, "status": result.status, "summary": result.summary, "error": result.error})
            return result
        except TaskCancelledError:
            raise
        except Exception as err:
            # Per-agent recovery: an unexpected crash must never abort the run.
            return self.fail(spec, f"Agent crashed: {err}", emit)

    def _emit_tool_event(self, emit, e: dict) -> None:
        # A single channel to the UI: tool events flow through onEvent, and the
        # dedicated onToolEvent callback stays available for consumers that want
        # tool activity separately from progress.
        emit(e)
        on_tool_event = self.deps.get("onToolEvent")
        if on_tool_event:
            on_tool_event(e)

    def throw_if_aborted(self) -> None:
        signal = self.deps.get("signal")
        if signal is not None and getattr(signal, "aborted", False):
            raise TaskCancelledError()

    def run_no_llm(self, role: str, spec, emit) -> SubagentResult:
        if role == "test-runner":
            result = run_deterministic_test_runner(self.runtime.root, self.runtime.project)
            emit({
                "type": "agent-done",
                "role": role,
                "label": spec.label,
                "status": result.status,
                "summary": result.summary,
                "error": result.error,
            })
            return result
        return self.fail(spec, f'Role "{role}" is marked no_llm but has no deterministic executor.', emit)

    def fail(self, spec, error: str, emit) -> SubagentResult:
        res = SubagentResult(
            agent=spec.role,
            label=spec.label,
            status="failed",
            summary=error,
            error=error,
            iterations=0,
            toolCalls=0,
        )
        emit({"type": "agent-done", "role": spec.role, "label": spec.label, "status": "failed", "summary": error, "error": error})
        return res

    # -------------------------------------------------------------------------
    # Permission serialization
    # -------------------------------------------------------------------------

    @property
    def serialized_ask(self):
        """User permission prompts are serialized so parallel agents cannot
        interleave."""

        def ask(command: str, reasons: list[str]) -> bool:
            prev = list(self.ask_queue)
            gate: list = []
            self.ask_queue.append(gate)
            for g in prev:
                if g:
                    g.wait()
            try:
                return self.runtime.ask(command, reasons)
            finally:
                for g in gate:
                    g.set()

        return ask

    # -------------------------------------------------------------------------
    # Metrics
    # -------------------------------------------------------------------------

    def build_metrics(self, clock: dict, acc: dict, results: list[SubagentResult], planner_calls: int) -> dict:
        metrics = {
            "llmCalls": planner_calls + acc["iterations"],
            "durationMs": time.monotonic() * 1000 - clock["startedAt"],
            "duplicateToolCalls": sum(r.metrics.get("duplicateToolCalls", 0) for r in results),
            "failedToolCalls": sum(r.metrics.get("failedToolCalls", 0) for r in results),
            "retries": sum(r.metrics.get("retries", 0) for r in results),
            "modelTimeMs": sum(r.metrics.get("modelTimeMs", 0) for r in results),
            "toolTimeMs": sum(r.metrics.get("toolTimeMs", 0) for r in results),
        }
        if clock.get("firstStatusAt") is not None:
            metrics["timeToFirstResponseMs"] = clock["firstStatusAt"] - clock["startedAt"]
        if clock.get("firstToolAt") is not None:
            metrics["timeToFirstToolCallMs"] = clock["firstToolAt"] - clock["startedAt"]
        return metrics


def compose_final_answer(results: list[SubagentResult], unavailable: list[str]) -> str:
    """Compose the user-facing final answer from the structured results."""
    # The LAST editor run wins (a review→fix pass supersedes the first attempt).
    editor = next((r for r in reversed(results) if r.agent == "editor"), None)
    completed = [r for r in results if r.status == "completed"]
    parts: list[str] = []

    if editor is not None:
        if editor.status == "completed":
            parts.append(editor.summary)
        elif editor.status == "failed":
            parts.append(f"The task failed: {editor.error or editor.summary}")
    elif completed:
        parts.append(completed[-1].summary)

    reviewer = next((r for r in results if r.agent == "code-reviewer" and r.status == "completed"), None)
    if reviewer is not None:
        notes = reviewer.recommendations[:3] if reviewer.recommendations else reviewer.findings[:3]
        if notes:
            parts.append("Review: " + " ".join(notes))

    tester = next((r for r in results if r.agent == "test-runner" and r.status == "completed"), None)
    if tester is not None and tester.summary:
        parts.append(f"Tests: {tester.summary}")

    browser_result = next((r for r in results if r.agent == "browser-use" and r.status == "unavailable"), None)
    if browser_result is not None:
        parts.append(browser_result.summary)

    if not parts:
        failed = [r for r in results if r.status == "failed"]
        if failed:
            return "The task could not be completed.\n" + "\n".join(f"{f.label}: {f.error or f.summary}" for f in failed)
        return "The task could not be completed."

    return "\n\n".join(p for p in parts if p)
