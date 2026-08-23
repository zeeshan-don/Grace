"""Context management (port of src/agent/context.ts)."""

import re

from grace.util_text import estimate_tokens

# Soft budget for conversation context sent to the model (tokens).
DEFAULT_CONTEXT_BUDGET = 28_000
MAX_TOOL_CONTENT_CHARS = 8_000


def project_bits(info) -> str:
    """Compact one-line project descriptor shared by the default and subagent prompts."""
    bits = [f"{info.type}{'/' + info.framework if info.framework else ''}", f"pm:{info.packageManager}"]
    if info.languages:
        bits.append(f"lang:{'+'.join(info.languages)}")
    if info.testCommand:
        bits.append(f"test:{info.testCommand}")
    if info.buildCommand:
        bits.append(f"build:{info.buildCommand}")
    return " · ".join(bits)


def build_system_prompt(info) -> str:
    bits = project_bits(info)
    return "\n".join([
        "You are GRACE, a coding agent working in the user's repository.",
        f"Project: {bits} · root {info.root}",
        "",
        "Identity:",
        "- You are GRACE, an AI coding agent built by Zeesh Studios.",
        "- You are NOT ChatGPT, NOT GPT, NOT from OpenAI. Never identify as ChatGPT, GPT, or any other AI assistant.",
        "- When asked who you are, always say you are GRACE, a coding agent by Zeesh Studios.",
        "",
        "Before changing anything, identify the application:",
        "- Establish the project type, framework, dependency/config files, likely entry points, source directories and test setup from the Index/context and config files (package.json, pyproject.toml, requirements.txt, Cargo.toml, go.mod, ...).",
        "- Never assume a file is the application entry point because of its name (hello.py may be a scratch script). Locate the real server/API entry point before editing.",
        "",
        "Workflow:",
        "- Inspect with read_file/search_files/list_directory before editing. Reuse what the Index already tells you instead of re-searching for it.",
        "- Minimal edits: edit_file for changes, write_file for new files.",
        "- After editing, run tests/build/lint via run_command; read errors, fix, re-run until green. Never start long-running servers or background processes to validate — use bounded checks (import/compile checks, unit tests, short one-shot probes).",
        "- When done, stop and report: files changed + how you verified.",
        "",
        "Rules:",
        "- Never read/write .env, keys, credentials or SSH material.",
        "- NEVER install or add dependencies (pip install, npm install <pkg>, poetry add, ...) unless the project already declares the dependency AND the user approved it. Inspect the dependency files first; the permission prompt enforces this.",
        "- Destructive commands (rm -rf, sudo, git push/reset, DB drops) are gated by a permission prompt; if denied, find a safe alternative. Never bypass it.",
        "- Never fabricate tool results. Only report what tools returned.",
        "- Keep reads focused; do not dump whole repos into context. Do not re-read a file you already have unless it may have changed.",
    ])


# Explicit file-ish targets named in a task (package.json, src/auth.ts, …).
_FILE_TARGET_RE = re.compile(
    r"\b(?:[A-Za-z0-9_./-]*[A-Za-z0-9_])\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|json|toml|ya?ml|md|txt|sh|css|html|sql|c|cpp|h)\b",
    re.I,
)


def task_scope_hint(task: str) -> str:
    """Task-scope guidance for targeted requests (GRACE context efficiency).

    "Inspect package.json and find bugs" should read package.json and answer —
    not browse api/health.ts or unrelated tests. When the user's task
    explicitly names one to three files, the agent gets a crisp scope rule.
    Returns '' (no hint) when the task is not a targeted-file task.
    """
    raw = _FILE_TARGET_RE.findall(task)
    targets = list(dict.fromkeys(re.sub(r"[.,;:!?]+$", "", m) for m in raw))
    if not targets or len(targets) > 3:
        return ""
    return "\n".join([
        "Task scope (targeted):",
        f"- The task explicitly names: {', '.join(targets)}.",
        "- Read ONLY those files plus the immediate dependencies they reference (imports, config, helpers they call).",
        "- Do NOT browse the repository for related code, entry points, directories or tests unless one of the named files actually requires it.",
        "- Answer the task from those files; if they are insufficient, state that and ask before exploring further.",
    ])


def trim_messages(messages: list[dict], budget: int) -> list[dict]:
    """Trim messages to fit the token budget. Keeps the system prompt, drops
    the oldest tool results and middle messages first, and truncates
    oversized tool contents."""
    trimmed: list[dict] = []
    for m in messages:
        if m.get("role") == "tool" and m.get("content") and len(m["content"]) > MAX_TOOL_CONTENT_CHARS:
            trimmed.append({**m, "content": m["content"][:MAX_TOOL_CONTENT_CHARS] + "\n… [tool result truncated]"})
        else:
            trimmed.append(m)

    total = sum(estimate_tokens(m.get("content") or "") for m in trimmed)
    if total <= budget:
        return trimmed

    # Drop oldest tool results, then middle messages, until under budget.
    over = total - budget
    i = 1  # keep index 0 (system)
    while over > 0 and i < len(trimmed):
        m = trimmed[i]
        cost = estimate_tokens(m.get("content") or "")
        if m.get("role") in ("tool", "assistant"):
            del trimmed[i]
            over -= cost
        else:
            i += 1
    # Last resort: drop middle messages — but never the user's own request
    # (index 1) nor the newest message.
    j = 2
    while over > 0 and j < len(trimmed) - 1:
        m = trimmed[j]
        cost = estimate_tokens(m.get("content") or "")
        del trimmed[j]
        over -= cost
        if j < len(trimmed) and trimmed[j].get("role") == "tool":
            over -= estimate_tokens(trimmed[j].get("content") or "")
            del trimmed[j]
    return trimmed
