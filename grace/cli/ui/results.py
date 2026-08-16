"""Structured result rendering (port of src/cli/ui/results.ts).

Turns a finished coordinator run into compact, real output:

    ✓ Done
    Implemented dashboard authentication.

    Updated:
      + src/auth/login.ts
      M src/auth/session.py

    Validation:
      ✓ Tests — 215/215 passed

      18.4s · 5 tool calls

Provider/model live in /status, never repeated after every task. Debug
diagnostics (plan, agent details, usage, full timing) are verbose-only.
Sections that carry no information are omitted.
"""

import os
import re

from grace.agent.errors import TASK_ERROR_LABELS, describe_run_error_category
from grace.cli.ui.box import kv, section
from grace.cli.ui.theme import symbols, theme
from grace.git import is_git_repo, status_short
from grace.providers.remote import RemoteProvider
from grace.util_text import format_duration

MAX_CHANGED_SHOWN = 12


# ---------------------------------------------------------------------------
# Task result sections
# ---------------------------------------------------------------------------


def render_task_result(info: dict) -> str:
    """Render the full post-task result block."""
    result = info["result"]
    runtime = info["runtime"]
    execution_time_ms = info.get("executionTimeMs", 0)
    verbose = info.get("verbose", False)
    sym = symbols()
    th = theme()
    parts: list[str] = []

    # Failure is decided by the PRIMARY worker (the last editor), or by a total
    # failure when no editor ran — a secondary agent (e.g. a researcher) failing
    # must not mislabel a task the editor completed.
    editor = next((r for r in reversed(result.results) if r.agent == "editor"), None)
    completed_any = any(r.status == "completed" for r in result.results)
    failed = editor.status == "failed" if editor else (not completed_any and any(r.status == "failed" for r in result.results))
    failure = editor.failure if editor else None

    if failed and failure:
        label = TASK_ERROR_LABELS.get(failure.get("category")) or "Task failed"
        parts.append(th["error"](sym["cross"] + " " + label))
        parts.append("")
        parts.append(describe_run_error_category(failure.get("category", "")))
        if failure.get("message"):
            parts.append(failure["message"])
        provider_line = " · ".join(x for x in [failure.get("providerLabel"), failure.get("modelId")] if x)
        if provider_line:
            parts.append("")
            parts.append(section("Provider"))
            parts.append("  " + th["provider"](provider_line))
        parts.append("")
    else:
        if failed:
            header = th["error"](sym["cross"] + " Task not completed")
        else:
            header = th["bold"](th["success"](sym["check"] + " Done"))
        parts.append(header)
        parts.append("")
        parts.append(result.finalAnswer.strip())
        parts.append("")

    files = classify_file_changes(result.changedFiles, runtime.root)
    if files:
        parts.append(section("Updated:"))
        for f in files[:MAX_CHANGED_SHOWN]:
            parts.append("  " + _status_mark(f["status"], th) + " " + th["path"](f["path"]))
        if len(files) > MAX_CHANGED_SHOWN:
            note = sym["ellipsis"] + f" and {len(files) - MAX_CHANGED_SHOWN} more (use /diff for the full list)"
            parts.append("  " + th["dim"](note))
        parts.append("")

    validation = _validation_lines(result.results, runtime.root)
    if validation:
        parts.append(section("Validation:"))
        parts.extend(validation)
        parts.append("")

    # Compact single-line footer: duration + tool calls + LLM calls.
    tool_word = "tool call" if result.toolCalls == 1 else "tool calls"
    llm_calls = result.metrics.get("llmCalls", 0)
    llm_word = "LLM call" if llm_calls == 1 else "LLM calls"
    footer = th["number"](format_duration(execution_time_ms)) + f" · {result.toolCalls} {tool_word} · {llm_calls} {llm_word}"
    parts.append("  " + th["dim"](footer))
    extra: list[str] = []
    if result.metrics.get("duplicateToolCalls"):
        extra.append(f"{result.metrics['duplicateToolCalls']} duplicate tool call(s)")
    if result.metrics.get("failedToolCalls"):
        extra.append(f"{result.metrics['failedToolCalls']} failed tool call(s)")
    if result.metrics.get("retries"):
        extra.append(f"{result.metrics['retries']} retr{'y' if result.metrics['retries'] == 1 else 'ies'}")
    if extra:
        parts.append("  " + th["dim"](" · ".join(extra)))

    if verbose:
        parts.append("")
        served = runtime.provider.server_provider if isinstance(runtime.provider, RemoteProvider) else None
        provider_label = (served or {}).get("label") or getattr(runtime.provider, "label", "unknown")
        model = runtime.provider.get_model().id if runtime.provider else "—"
        parts.append(section("Provider"))
        parts.append("  " + th["provider"](provider_label) + f" {sym['bullet']} " + th["model"](model))
        parts.append("")

        parts.append(section("Time"))
        m = result.metrics
        time_value = th["number"](format_duration(execution_time_ms)) + f" · {result.iterations} iteration(s) · {result.toolCalls} tool call(s) · {m.get('llmCalls', 0)} LLM call(s)"
        parts.append("  " + time_value)
        detail: list[str] = []
        if m.get("duplicateToolCalls"):
            detail.append(f"{m['duplicateToolCalls']} duplicate tool call(s)")
        if m.get("failedToolCalls"):
            detail.append(f"{m['failedToolCalls']} failed tool call(s)")
        if m.get("retries"):
            detail.append(f"{m['retries']} retr{'y' if m['retries'] == 1 else 'ies'}")
        if m.get("modelTimeMs") is not None:
            detail.append("model wait " + format_duration(m["modelTimeMs"]))
        if m.get("toolTimeMs") is not None:
            detail.append("tool exec " + format_duration(m["toolTimeMs"]))
        if detail:
            parts.append("  " + th["dim"](" · ".join(detail)))
        parts.append("")

        plan = _render_plan(result)
        if plan:
            parts.append(section("Plan"))
            parts.append(plan)
            parts.append("")
        details = _render_agent_details(result.results)
        if details:
            parts.append(section("Agent details"))
            parts.extend(details)
            parts.append("")
        if result.usage:
            parts.append(section("Usage"))
            parts.append(f"  {result.usage['inputTokens']} tokens in · {result.usage['outputTokens']} tokens out · {result.usage['totalTokens']} total")
            parts.append("")

    return "\n".join(parts).rstrip("\n")


def _validation_lines(results, root: str) -> list[str]:
    sym = symbols()
    th = theme()
    lines: list[str] = []
    tester = next((r for r in results if r.agent == "test-runner"), None)
    if tester:
        lines.append(_agent_validation_line("Tests", tester, sym, th))
    reviewer = next((r for r in results if r.agent == "code-reviewer"), None)
    if reviewer:
        lines.append(_agent_validation_line("Review", reviewer, sym, th))
    # Git is a positive signal only — a dirty tree is expected after edits.
    if is_git_repo(root):
        clean = status_short(root).strip() == ""
        if clean:
            lines.append("  " + th["success"](sym["check"] + " Git — working tree clean"))
    return lines


def _agent_validation_line(label: str, r, sym, th) -> str:
    if r.status == "completed":
        detail = one_liner(r.summary)
        return "  " + th["success"](sym["check"]) + f" {label} — {detail}"
    if r.status == "failed":
        detail = one_liner(r.error or r.summary)
        return "  " + th["error"](sym["cross"]) + f" {label} — {detail}"
    detail = one_liner(r.summary)
    return "  " + th["warn"](sym["warn"]) + f" {label} — {detail}"


def _render_plan(result) -> str:
    lines = []
    for i, s in enumerate(result.plan.steps):
        lines.append(f"  {i + 1}. " + " ".join(s.agents))
    return "\n".join(lines)


def _render_agent_details(results) -> list[str]:
    sym = symbols()
    th = theme()
    out: list[str] = []
    for r in results:
        if r.status == "completed":
            mark = th["success"](sym["check"])
        elif r.status == "failed":
            mark = th["error"](sym["cross"])
        else:
            mark = th["warn"](sym["warn"])
        out.append("  " + th["agent"](r.label) + " " + mark)
        if r.summary:
            out.append("      " + one_liner(r.summary))
        files = r.files[:5]
        if files:
            out.append("      files: " + ", ".join(th["path"](f) for f in files))
        for f in r.findings[:3]:
            out.append("      finding: " + one_liner(f))
    return out


# ---------------------------------------------------------------------------
# File changes
# ---------------------------------------------------------------------------


def _parse_status_short(output: str) -> dict[str, str]:
    """Parse `git status --short` output into path → status codes."""
    mapping: dict[str, str] = {}
    for raw in output.split("\n"):
        line = raw.rstrip()
        if not line:
            continue
        m = re.match(r"^(.{1,2})\s+(.+)$", line)
        if not m:
            continue
        codes = m.group(1).strip()
        path = m.group(2).strip().strip('"')
        if codes and path:
            mapping[path] = codes
    return mapping


def classify_file_changes(changed_files: list[str], root: str, opts: dict | None = None) -> list[dict]:
    """Classify the agent's changed files with git status markers:
    '+' added, 'M' modified, '-' deleted. Without git, creations default to '+'."""
    opts = opts or {}
    is_repo = (opts.get("isRepo") or is_git_repo)(root)
    status = _parse_status_short((opts.get("getStatus") or status_short)(root)) if is_repo else {}

    out = []
    for path in changed_files:
        codes = status.get(path)
        if codes is None:
            if is_repo:
                s = "M" if os.path.exists(os.path.join(root, path)) else "D"
            else:
                s = "A"
        elif "D" in codes:
            s = "D"
        elif "A" in codes or codes == "??":
            s = "A"
        else:
            s = "M"
        out.append({"status": s, "path": path})
    return out


def _status_mark(status: str, th) -> str:
    if status == "A":
        return th["success"]("+")
    if status == "D":
        return th["error"]("-")
    return th["warn"]("M")


# ---------------------------------------------------------------------------
# Errors & long output
# ---------------------------------------------------------------------------


def render_error(message: str, hint: str | None = None) -> str:
    """Concise, secret-safe error block."""
    sym = symbols()
    th = theme()
    lines = [th["error"](sym["cross"] + " " + message)]
    if hint:
        lines.append("  " + th["dim"](hint))
    return "\n".join(lines)


def collapse_lines(input_text: str, opts: dict | None = None) -> str:
    """Indent long command output and hide the tail behind a notice."""
    opts = opts or {}
    max_lines = 500 if opts.get("verbose") else (opts.get("max") or 40)
    lines = input_text.replace("\r\n", "\n").split("\n")
    if len(lines) <= max_lines:
        return "\n".join(f"  {l}" for l in lines)
    sym = symbols()
    th = theme()
    head = lines[: max(0, max_lines - 2)]
    hidden = len(lines) - len(head)
    tail = "  " + th["dim"](f"[{hidden} line(s) hidden — use /verbose to show]")
    return "\n".join([*[f"  {l}" for l in head], "  " + sym["ellipsis"], tail])


def output_count_line(label: str, lines: int) -> str:
    """Render a \"N lines\" count line, e.g. \"Command output 142 lines\"."""
    th = theme()
    word = "line" if lines == 1 else "lines"
    return "  " + th["label"](label) + " " + th["number"](str(lines)) + f" {word}"


# ---------------------------------------------------------------------------
# /model and /status panels
# ---------------------------------------------------------------------------


def render_model_panel(info: dict) -> str:
    sym = symbols()
    th = theme()
    out: list[str] = []
    if not info.get("providerAvailable"):
        out.append(section("Provider"))
        out.append("  " + th["error"](sym["cross"] + " " + (info.get("providerError") or "not configured")))
        return "\n".join(out)
    out.append(section("Provider"))
    out.append("  " + th["provider"](info["providerLabel"]) + " " + th["success"](sym["check"]))
    out.append(section("Model"))
    out.append("  " + th["model"](info["model"]))
    out.append(section("Context"))
    out.append("  ~" + th["number"](str(round(info["contextWindow"] / 1000))) + "k tokens")
    if info.get("servedVia"):
        out.append(section("Served via"))
        out.append("  " + th["provider"](info["servedVia"]))
    return "\n".join(out)


def render_status_panel(info: dict) -> str:
    sym = symbols()
    th = theme()
    project = info["project"]
    git = info["git"]
    provider = info["provider"]
    session = info["session"]
    free_plan = info.get("freePlan") or []
    runtime = info["runtime"]
    out: list[str] = []
    PAD = 14

    out.append(section("Project"))
    out.append(kv("Directory", th["path"](project["directory"]), PAD))
    out.append(kv("Type", project["type"], PAD))
    out.append(kv("Package mgr", project["packageManager"], PAD))
    out.append(kv("Languages", ", ".join(project["languages"]) or "—", PAD))
    if project.get("configFiles"):
        out.append(kv("Config", ", ".join(project["configFiles"][:10]), PAD))
    if project.get("testCommand") or project.get("buildCommand"):
        out.append(kv("Test/build", " · ".join(x for x in [project.get("testCommand"), project.get("buildCommand")] if x), PAD))

    out.append(section("Git"))
    if not git["isRepo"]:
        out.append("  Not a git repository")
    else:
        out.append(kv("Branch", git["branch"] or "(detached)", PAD))
        if git["hasChanges"]:
            out.append(kv("Working tree", th["warn"](f"{git['statusLines']} change(s)"), PAD))
        else:
            out.append(kv("Working tree", th["success"](f"clean {sym['check']}"), PAD))

    out.append(section("Model"))
    if provider["available"]:
        out.append(kv("Provider", th["provider"](provider["label"]) + " " + th["success"](sym["check"]), PAD))
        out.append(kv("Model", th["model"](provider["model"]), PAD))
        if provider.get("servedVia"):
            out.append(kv("Served via", th["provider"](provider["servedVia"]), PAD))
        out.append(kv("Context", "~" + th["number"](str(round(provider["contextWindow"] / 1000))) + "k tokens", PAD))
    else:
        err_text = provider.get("error") or "not configured"
        short_err = f"{err_text[:55]}{sym['ellipsis']}" if len(err_text) > 58 else err_text
        out.append(kv("Provider", th["error"](short_err), PAD))

    out.append(section("Session"))
    out.append(kv("Messages", str(session["messages"]), PAD))
    out.append(kv("Tool calls", str(session["toolCalls"]), PAD))
    out.append(kv("Runs", str(session["runs"]), PAD))
    out.append(kv("Tokens in/out", f"{session['inputTokens']} / {session['outputTokens']}", PAD))
    out.append(kv("Undo stack", f"{session['undoSnapshots']} snapshot(s)", PAD))

    if free_plan:
        out.append(section("Free plan"))
        out.extend(free_plan)

    out.append(section("Runtime"))
    out.append(kv("Python", runtime.get("python", ""), PAD))
    out.append(kv("Platform", runtime.get("platform", ""), PAD))
    out.append(kv("State dir", th["path"](runtime["stateDir"]), PAD))

    return "\n".join(out)


def one_liner(text: str) -> str:
    """Collapse a multi-line string to one line (shared with progress)."""
    flat = re.sub(r"\s+", " ", text).strip()
    return f"{flat[:159]}…" if len(flat) > 160 else flat
