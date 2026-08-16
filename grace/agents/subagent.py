"""Subagent execution (port of src/agents/subagent.ts)."""

from grace.agent.errors import format_run_error
from grace.agent.loop import AgentLoop
from grace.agents.compact import compact_text
from grace.agents.structured import parse_structured_result
from grace.agents.types import SubagentResult

# AgentLoop prefixes provider failures with this text (see loop.py run_turn).
PROVIDER_FAILURE_MARKER = "I could not reach the AI provider"


def run_subagent(opts: dict, spec, task: str, context_text: str) -> SubagentResult:
    system_prompt = f"{spec.systemPrompt}\n\nContext:\n{compact_text(context_text, 12_000)}"

    loop = AgentLoop({
        "provider": opts["provider"],
        "tools": opts["tools"],
        "projectRoot": opts["projectRoot"],
        "project": opts["project"],
        "session": opts["session"],
        "undo": opts["undo"],
        "system_prompt": system_prompt,
        "ask_permission": opts["askPermission"],
        "max_iterations": spec.maxIterations,
        "context_budget": spec.contextBudget,
        "on_status": opts.get("onStatus"),
        "on_tool_event": opts.get("onToolEvent"),
        "signal": opts.get("signal"),
    })

    result = loop.run(task)

    # A classified loop failure (provider / parser / tool) supersedes the text
    # marker — the UI reports the ACTUAL failure category.
    failed = bool(result["error"]) or result["finalText"].startswith(PROVIDER_FAILURE_MARKER)
    parsed = parse_structured_result(result["finalText"]) if spec.structured else None

    files = list(dict.fromkeys([*(parsed.get("files") if parsed else []), *result["changedFiles"]]))
    summary = result["finalText"] if failed else (parsed.get("summary", "").strip() if parsed else "") or result["finalText"] or "(no response)"

    return SubagentResult(
        agent=spec.role,
        label=spec.label,
        status="failed" if failed else "completed",
        summary=summary,
        files=files,
        changedFiles=result["changedFiles"],
        findings=(parsed.get("findings") if parsed else []) or [],
        recommendations=(parsed.get("recommendations") if parsed else []) or [],
        error=format_run_error(result["error"]) if failed and result["error"] else (summary if failed else None),
        failure=result["error"],
        metrics={
            "llmCalls": result["iterations"],
            "durationMs": result["durationMs"],
            "duplicateToolCalls": result["duplicateToolCalls"],
            "failedToolCalls": result["failedToolCalls"],
            "retries": result["retries"],
            "modelTimeMs": result["modelTimeMs"],
            "toolTimeMs": result["toolTimeMs"],
        },
        iterations=result["iterations"],
        toolCalls=result["toolCalls"],
        usage=result["usage"],
    )
