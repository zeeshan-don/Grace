"""UI event adapter (the TUI's clean boundary to the agent).

The TUI never couples to provider/tool internals. The coordinator emits a flat
stream of generic events; this adapter translates them into the store's
user-facing activity feed and live working-status line. It renders ONLY safe
summaries — tool names and human phrasing — never raw tool arguments, JSON,
internal prompts or chain-of-thought.

Event model (coordinator → adapter → store):

    TaskStarted      route / planning / working
    ThinkingStarted  planning
    ToolStarted      tool-start   → pending activity line
    ToolCompleted    tool-end ok  → ✓ in place (green)
    ToolFailed       tool-end !ok → ✗ in place (red)
    TaskCompleted    agent-done + result block (rendered by the runner)
    TaskFailed       agent-done failed / runner exception
    SessionUpdated   free-plan state (header countdown, rendered by the app)

Activity lines update in place (push_pending/finish_pending) instead of
printing duplicate status lines, and the working status (``● Thinking`` /
``● Working`` / ``● Running tests``) is a single live line.
"""

import re

from grace.verbose import is_verbose


def friendly_tool(tool: str, args: dict, completed: bool = False) -> str:
    """Human-friendly, one-line rendering of a tool call (no raw JSON).

    Pending form is present tense (``Reading api/provider.py``), completed form
    is past tense (``Read api/provider.py``) so the check mark reads naturally.
    """
    if tool == "read_file":
        p = _path(args.get("path"))
        return _pair("Reading {p}", "Read {p}", p, "Reading a file", "Read a file", completed)
    if tool == "write_file":
        p = _path(args.get("path"))
        return _pair("Writing {p}", "Created {p}", p, "Writing a file", "Created a file", completed)
    if tool == "edit_file":
        p = _path(args.get("path"))
        return _pair("Editing {p}", "Edited {p}", p, "Editing a file", "Edited a file", completed)
    if tool == "search_files":
        q = str(args.get("query") or args.get("pattern") or "").strip()
        return _pair("Searching for {q}", "Searched for {q}", q, "Searching files", "Searched files", completed)
    if tool == "list_directory":
        p = _path(args.get("path"))
        return _pair("Listing {p}", "Listed {p}", p, "Listing directory", "Listed directory", completed)
    if tool == "run_command":
        cmd = str(args.get("command") or "").strip()
        if _is_test_command(cmd):
            return ("Ran tests" if completed else "Running tests")
        return _pair("Running {cmd}", "Ran {cmd}", cmd, "Running a command", "Ran a command", completed)
    if tool == "git_diff":
        return "Checked git status" if completed else "Checking git status"
    if tool == "web_fetch":
        url = str(args.get("url") or "").strip()
        return _pair("Fetching {url}", "Fetched {url}", url, "Fetching a URL", "Fetched a URL", completed)
    return tool


def _pair(pending_fmt: str, done_fmt: str, value: str, pending_fallback: str, done_fallback: str, completed: bool) -> str:
    if value:
        return (done_fmt if completed else pending_fmt).format(**{_slot(pending_fmt): value})
    return done_fallback if completed else pending_fallback


def _slot(fmt: str) -> str:
    m = re.search(r"\{(\w+)\}", fmt)
    return m.group(1) if m else "p"


def _path(raw) -> str:
    if not raw:
        return ""
    p = str(raw).strip()
    # Keep the path readable: show the tail when it is long.
    if len(p) > 46:
        return "…" + p[-45:]
    return p


def _is_test_command(cmd: str) -> bool:
    parts = cmd.split()
    first = (parts[0] if parts else "").lower()
    second = (parts[1] if len(parts) > 1 else "").lower()
    if first in ("npm", "npx", "yarn", "pnpm", "bun", "go", "cargo", "dotnet"):
        return second == "test" or second.startswith("test:")
    if first in ("pytest", "nosetests"):
        return True
    if first in ("py", "python", "python3") and second == "-m":
        return len(parts) > 2 and parts[2].startswith("pytest")
    return False


def _is_tool_status(message: str) -> bool:
    return re.match(r"^→ \S+ ", message.strip()) is not None


def _is_noise(message: str) -> bool:
    m = message.strip()
    return m in ("Thinking…", "Thinking...") or re.match(r"^Done in \d+ iteration", m) is not None or m.startswith("    ⚙ ")


def _one_liner(text: str) -> str:
    flat = re.sub(r"\s+", " ", text).strip()
    return f"{flat[:159]}…" if len(flat) > 160 else flat


class TuiEventAdapter:
    """Translate coordinator events into TuiStore state transitions.

    Pure and thread-safe by construction: it only mutates the store (which
    serializes notifications) and holds a small map of in-flight tool lines.
    """

    def __init__(self, store, verbose_fn=None) -> None:
        self.store = store
        self._verbose = verbose_fn or is_verbose
        # tool name → queue of pending activity item ids (parallel agents may
        # interleave identical tools; FIFO keeps them in order).
        self._tool_items: dict[str, list[int]] = {}

    # ------------------------------------------------------------------
    # Dispatch
    # ------------------------------------------------------------------

    def handle(self, e: dict) -> None:
        etype = e.get("type")
        if etype == "planning":
            self.store.set_working_status("Thinking")
        elif etype == "working":
            self.store.set_working_status("Working")
        elif etype == "status":
            self._on_status(e.get("message") or "")
        elif etype == "tool-start":
            self._on_tool_start(e)
        elif etype == "tool-end":
            self._on_tool_end(e)
        elif etype == "file-changed":
            self.store.record_changed_file(e.get("path") or "")
        elif etype == "permission-request":
            self.store.push("info", f"Permission needed: {e.get('command')}")
        elif etype == "permission-result":
            if e.get("allowed"):
                self.store.push("success", f"Allowed: {e.get('command')}")
            else:
                self.store.push("info", f"Denied: {e.get('command')}")
        elif etype == "step-start":
            if self._verbose():
                self.store.push("progress", f"Step {e.get('step')}/{e.get('total')}")
        elif etype == "agent-start":
            if self._verbose():
                self.store.push("info", e.get("label") or e.get("role") or "")
        elif etype == "agent-done":
            self._on_agent_done(e)
        # route / done / text-chunk are handled by the runner directly.

    # ------------------------------------------------------------------
    # Per-event translation
    # ------------------------------------------------------------------

    def _on_status(self, message: str) -> None:
        # Status lines are model diagnostics: debug-only, and tool-status /
        # noise lines are never rendered (tool activity has its own channel).
        if not self._verbose():
            return
        if _is_tool_status(message) or _is_noise(message):
            return
        self.store.push("progress", message)

    def _on_tool_start(self, e: dict) -> None:
        store = self.store
        tool = e.get("tool") or ""
        args = e.get("args") or {}
        item_id = store.push_pending(
            friendly_tool(tool, args, completed=False),
            kind="tool",
            meta={"tool": tool, "args": args},
        )
        self._tool_items.setdefault(tool, []).append(item_id)
        store.record_tool_call()

    def _on_tool_end(self, e: dict) -> None:
        store = self.store
        tool = e.get("tool") or ""
        ok = bool(e.get("ok"))
        queue = self._tool_items.get(tool) or []
        if not queue:
            return
        item_id = queue.pop(0)
        item = store.get_item(item_id)
        meta = (item or {}).get("meta") or {}
        tool_name = meta.get("tool") or tool
        args = meta.get("args") or {}
        if ok:
            text = friendly_tool(tool_name, args, completed=True)
        else:
            # A failed tool keeps its in-progress phrasing with the red cross:
            # "✗ Reading api/provider.py" — clear without inventing detail.
            text = friendly_tool(tool_name, args, completed=False)
        store.finish_pending(item_id, ok=ok, text=text)

    def _on_agent_done(self, e: dict) -> None:
        # The editor's terminal state is rendered once, in the final answer
        # block ("✓ Done" / "✗ …"), so the feed never repeats it. Verbose mode
        # keeps the per-agent summaries for diagnosis.
        if e.get("role") not in (None, "editor"):
            return
        if not self._verbose():
            return
        if e.get("status") == "failed":
            self.store.push("error", _one_liner(e.get("error") or e.get("summary") or "The task failed."))
        elif e.get("status") == "completed":
            self.store.push("success", e.get("summary") or "Done.")

    def reset(self) -> None:
        self._tool_items.clear()
