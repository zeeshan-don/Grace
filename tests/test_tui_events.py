"""UI event adapter tests: coordinator events → safe store state transitions.

The adapter is the TUI's clean boundary to the agent: it must never leak raw
tool arguments / internal diagnostics into the feed, tool lines must settle in
place (no duplicate status lines), and the working status stays a single live
line.
"""

from grace.cli.tui.events import TuiEventAdapter, friendly_tool
from grace.cli.tui.store import TuiStore


def _store() -> TuiStore:
    return TuiStore({
        "version": "test",
        "workspace": ".",
        "provider": "",
        "providerAvailable": False,
        "model": "",
        "session": "Local mode",
    })


def _adapter(verbose: bool = False):
    store = _store()
    adapter = TuiEventAdapter(store, verbose_fn=lambda: verbose)
    return store, adapter


# ---------------------------------------------------------------------------
# friendly_tool — human phrasing, no raw JSON
# ---------------------------------------------------------------------------


def test_friendly_tool_present_and_past_tense():
    assert friendly_tool("read_file", {"path": "package.json"}) == "Reading package.json"
    assert friendly_tool("read_file", {"path": "package.json"}, completed=True) == "Read package.json"
    assert friendly_tool("search_files", {"query": "provider configuration"}) == "Searching for provider configuration"
    assert friendly_tool("write_file", {"path": "calculator.py"}, completed=True) == "Created calculator.py"
    assert friendly_tool("git_diff", {}) == "Checking git status"
    assert friendly_tool("git_diff", {}, completed=True) == "Checked git status"


def test_friendly_tool_running_tests():
    assert friendly_tool("run_command", {"command": "pytest tests/"}) == "Running tests"
    assert friendly_tool("run_command", {"command": "npm test"}, completed=True) == "Ran tests"
    assert friendly_tool("run_command", {"command": "python -m pytest"}) == "Running tests"
    assert friendly_tool("run_command", {"command": "npm install"}) == "Running npm install"


def test_friendly_tool_never_contains_raw_arguments():
    text = friendly_tool("write_file", {"path": "a.py", "content": "print('secret')"})
    assert "print(" not in text
    assert "secret" not in text


# ---------------------------------------------------------------------------
# Event → store transitions
# ---------------------------------------------------------------------------


def test_planning_sets_thinking_status():
    store, adapter = _adapter()
    adapter.handle({"type": "planning"})
    assert store.working_status == "Thinking"


def test_working_sets_working_status():
    store, adapter = _adapter()
    adapter.handle({"type": "working"})
    assert store.working_status == "Working"


def test_tool_start_pushes_pending_line_and_counts():
    store, adapter = _adapter()
    adapter.handle({"type": "tool-start", "tool": "read_file", "args": {"path": "package.json"}})
    assert len(store.items) == 1
    assert store.items[0]["kind"] == "tool"
    assert store.items[0]["pending"] is True
    assert store.items[0]["text"] == "Reading package.json"
    assert store.tool_call_count == 1


def test_tool_completed_settles_in_place_green():
    store, adapter = _adapter()
    adapter.handle({"type": "tool-start", "tool": "read_file", "args": {"path": "package.json"}})
    adapter.handle({"type": "tool-end", "tool": "read_file", "ok": True})
    assert len(store.items) == 1  # updated in place — no duplicate line
    item = store.items[0]
    assert item["kind"] == "success"
    assert item["text"] == "Read package.json"
    assert item["pending"] is False


def test_tool_failed_settles_in_place_red():
    store, adapter = _adapter()
    adapter.handle({"type": "tool-start", "tool": "run_command", "args": {"command": "pytest"}})
    adapter.handle({"type": "tool-end", "tool": "run_command", "ok": False})
    item = store.items[0]
    assert item["kind"] == "error"
    assert item["text"] == "Running tests"


def test_parallel_tools_with_same_name_settle_in_order():
    store, adapter = _adapter()
    adapter.handle({"type": "tool-start", "tool": "read_file", "args": {"path": "a.py"}})
    adapter.handle({"type": "tool-start", "tool": "read_file", "args": {"path": "b.py"}})
    adapter.handle({"type": "tool-end", "tool": "read_file", "ok": True})  # first completes
    adapter.handle({"type": "tool-end", "tool": "read_file", "ok": True})  # second completes
    assert [i["text"] for i in store.items] == ["Read a.py", "Read b.py"]


def test_status_events_are_verbose_only_and_filtered():
    store, adapter = _adapter(verbose=False)
    adapter.handle({"type": "status", "message": "Inspecting project layout"})
    assert store.items == []

    store, adapter = _adapter(verbose=True)
    adapter.handle({"type": "status", "message": "Inspecting project layout"})
    assert [i["text"] for i in store.items] == ["Inspecting project layout"]

    # Tool-status and noise lines are never rendered even in verbose.
    adapter.handle({"type": "status", "message": "→ read_file package.json {\"path\": \"package.json\"}"})
    adapter.handle({"type": "status", "message": "Thinking…"})
    assert len(store.items) == 1


def test_editor_agent_done_adds_no_feed_noise_in_normal_mode():
    store, adapter = _adapter(verbose=False)
    adapter.handle({"type": "agent-done", "role": "editor", "label": "Grace", "status": "completed", "summary": "All done."})
    adapter.handle({"type": "agent-done", "role": "editor", "label": "Grace", "status": "failed", "summary": "boom", "error": "boom"})
    assert store.items == []  # the final answer block renders completion once


def test_editor_agent_done_verbose_keeps_diagnostics():
    store, adapter = _adapter(verbose=True)
    adapter.handle({"type": "agent-done", "role": "editor", "label": "Grace", "status": "failed", "error": "Provider timeout"})
    assert store.items[0]["kind"] == "error"
    assert "Provider timeout" in store.items[0]["text"]


def test_file_changed_records_without_feed_noise():
    store, adapter = _adapter()
    adapter.handle({"type": "file-changed", "path": "calculator.py"})
    assert store.changed_files == ["calculator.py"]
    assert store.items == []
