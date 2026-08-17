"""TUI store tests: activity feed, unique ids, permission flow, scrolling.

Regression guard: _next_id() used to be shadowed by the module-level list it
mutates, so every store.push() raised
``TypeError: 'function' object is not subscriptable`` and the full-screen TUI
fell back to the classic prompt.
"""

from grace.cli.tui.store import TuiStore, _next_id


def _store() -> TuiStore:
    return TuiStore({
        "version": "test",
        "workspace": ".",
        "provider": "",
        "providerAvailable": False,
        "model": "",
        "session": "Local mode",
    })


def test_next_id_returns_unique_increasing_ints():
    ids = [_next_id() for _ in range(5)]
    assert ids == sorted(ids)
    assert len(set(ids)) == 5


def test_push_assigns_unique_ids_and_split_lines():
    store = _store()
    store.push("result", "line one\nline two\n\n  ")
    assert len(store.items) == 2
    ids = [item["id"] for item in store.items]
    assert len(set(ids)) == 2
    assert store.items[0]["text"] == "line one"
    assert store.items[1]["text"] == "line two"


def test_push_does_not_raise_with_multiline_output():
    # The exact crash the TUI hit: any line routed into the feed.
    store = _store()
    store.push("console", "warning: something\nnote: another")
    assert len(store.items) == 2


def test_push_kinds_and_busy_state():
    store = _store()
    store.set_busy(True)
    assert store.busy is True
    store.push("user", "hello")
    assert store.items[0]["kind"] == "user"
    store.set_busy(False)
    assert store.busy is False


def test_scroll_stays_in_bounds():
    store = _store()
    for i in range(20):
        store.push("info", f"line {i}")
    store.scroll_up(1000)
    assert store.scroll == len(store.items) - 1
    store.scroll_to_bottom()
    assert store.scroll == 0


def test_permission_flow_answers():
    import threading

    store = _store()
    results: list[bool] = []

    def ask():
        results.append(store.ask_permission("rm -rf x", ["dangerous"]))

    t = threading.Thread(target=ask, daemon=True)
    t.start()
    assert store.permission is not None
    store.answer_permission(True)
    t.join(timeout=2)
    assert results == [True]
    assert store.permission is None


def test_input_editing_history():
    store = _store()
    store.insert("h")
    store.insert("i")
    assert store.input == "hi"
    store.backspace()
    assert store.input == "h"
    store.submit_input()
    assert store.history == ["h"]
    store.history_up()
    assert store.input == "h"
