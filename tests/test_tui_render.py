"""Rendering tests for the redesigned TUI layout.

These drive the real app through Textual's event loop and assert on the
rendered widget content — the header, the activity feed (user separators,
in-place tool settling, answer blocks, working status) and the fixed input bar
with its placeholder. They pin the visual contract so future changes cannot
silently regress the workspace layout.
"""

import asyncio
import re

from grace.cli.tui.app import GraceTuiApp
from grace.cli.tui.store import TuiStore

_MARKUP = re.compile(r"\[/?[^\]]*\]")


def _visible(line: str) -> str:
    """Strip Rich markup tags so we measure what the terminal actually shows."""
    return _MARKUP.sub("", line)


class _StubRunner:
    def __init__(self) -> None:
        self.submitted: list[str] = []

    def is_busy(self) -> bool:
        return False

    def cancel_task(self) -> None:
        pass

    def remember_prefix(self, command: str) -> None:
        pass

    def submit_auth(self) -> None:
        pass

    def run_slash(self, text: str) -> bool:
        return False

    def run_task(self, text: str) -> None:
        self.submitted.append(text)


def _make():
    store = TuiStore({
        "version": "test",
        "workspace": "acme",
        "provider": "Groq",
        "providerAvailable": True,
        "model": "gpt-oss-20b",
        "session": "Local mode",
    })
    runner = _StubRunner()
    app = GraceTuiApp(store, runner, lambda: None)
    return store, runner, app


def _body(store, app) -> str:
    return app._render_body()


def test_home_screen_renders_wordmark_and_hint():
    async def drive():
        store, runner, app = _make()
        async with app.run_test():
            body = _body(store, app)
            # Wordmark renders as block letters (80x24 test size) or the
            # compact "G   R   A   C   E" on small terminals.
            assert "GRACE" in body or "G   R   A   C   E" in body or "█" in body
            assert "Describe a coding task below" in body
            assert "/help" in body
        return store

    asyncio.run(drive())


def test_activity_feed_shows_user_prompt_separated_from_activity():
    async def drive():
        store, runner, app = _make()
        store.mode = "session"
        store.push("user", "Inspect package.json and find any bugs")
        store.push_pending("Reading package.json", kind="tool")
        async with app.run_test():
            body = _body(store, app)
            assert "› Inspect package.json and find any bugs" in body
            assert "Reading package.json" in body
        return store

    asyncio.run(drive())


def test_tool_line_settles_in_place_into_check():
    async def drive():
        store, runner, app = _make()
        store.mode = "session"
        store.push("user", "check package.json")
        item_id = store.push_pending("Reading package.json", meta={})
        store.finish_pending(item_id, ok=True, text="Read package.json")
        async with app.run_test():
            body = _body(store, app)
            assert "Read package.json" in body
            assert "Reading package.json" not in body  # settled in place
        return store

    asyncio.run(drive())


def test_answer_block_stands_apart_from_activity():
    async def drive():
        store, runner, app = _make()
        store.mode = "session"
        store.push("user", "fix the bug")
        store.push_pending("Reading api/provider.py", kind="tool")
        store.push("result", "✓ Done")
        store.push("result", "Fixed the bug by adding a guard clause.")
        async with app.run_test():
            body = _body(store, app)
            assert "✓ Done" in body
            assert "Fixed the bug by adding a guard clause." in body
            assert "Reading api/provider.py" in body
        return store

    asyncio.run(drive())


def test_working_status_line_renders_while_busy():
    async def drive():
        store, runner, app = _make()
        store.mode = "session"
        store.push("user", "run the tests")
        store.set_busy(True)
        store.set_working_status("Working")
        async with app.run_test():
            body = _body(store, app)
            assert "●" in body and "Working" in body
        return store

    asyncio.run(drive())


def test_user_prompt_is_pinned_when_feed_overflows():
    """At 80x24 the latest user prompt stays visible above a long answer so
    USER REQUEST → ACTIVITY → FINAL ANSWER always reads."""
    async def drive():
        store, runner, app = _make()
        store.mode = "session"
        store.push("user", "Inspect package.json and find any bugs")
        for i in range(30):
            store.push("result", f"answer line {i} with some detail about what was found")
        async with app.run_test():
            body = _body(store, app)
            assert "› Inspect package.json and find any bugs" in body
        return store

    asyncio.run(drive())


def test_brackets_in_user_text_are_escaped_from_markup():
    """Literal [text] in user input must never be parsed as Rich markup."""
    async def drive():
        store, runner, app = _make()
        store.mode = "session"
        store.push("user", "fix [bug] #42")
        async with app.run_test():
            body = _body(store, app)
            assert "fix \\[bug] #42" in body  # escaped opening bracket
        return store

    asyncio.run(drive())


def test_ascii_mode_renders_ok_x_markers(monkeypatch):
    """Legacy consoles use [ok]/[x] — they must render literally, not vanish
    as markup tags."""
    import os

    async def drive():
        os.environ["ZEESH_ASCII"] = "1"
        try:
            store, runner, app = _make()
            store.mode = "session"
            store.push("user", "check")
            store.push("success", "Read package.json")
            store.push("error", "Running tests")
            async with app.run_test():
                body = _body(store, app)
                # The ASCII fallback markers survive as literal text (they are
                # separate markup spans, so assert on the escaped fragments).
                assert "\\[ok]" in body
                assert "\\[x]" in body
                assert "Read package.json" in body
                assert "Running tests" in body
        finally:
            os.environ.pop("ZEESH_ASCII", None)
        return store

    asyncio.run(drive())


def test_working_status_clears_when_task_done():
    async def drive():
        store, runner, app = _make()
        store.mode = "session"
        store.push("user", "run the tests")
        store.set_busy(True)
        store.set_working_status("Working")
        store.set_busy(False)
        async with app.run_test():
            body = _body(store, app)
            assert "Working" not in body
        return store

    asyncio.run(drive())


def test_input_bar_placeholder_and_fixed_position():
    async def drive():
        store, runner, app = _make()
        async with app.run_test():
            rendered = app._render_input()
            assert "Enter a coding task" in rendered
            # The input is a bordered box, not a bare prompt line.
            assert "┌" in rendered and "└" in rendered
            # Every box row is the same width (borders align).
            widths = {len(_visible(line)) for line in rendered.split("\n")}
            assert len(widths) == 1, f"input box rows misaligned: {widths}"
            # It lives in its own widget below the body — never inside the
            # scrolling activity area.
            assert app._input is not None
            assert app._body is not None
        return store

    asyncio.run(drive())


def test_input_box_stays_aligned_while_typing():
    async def drive():
        store, runner, app = _make()
        async with app.run_test():
            store.insert("hey")
            rendered = app._render_input()
            widths = {len(_visible(line)) for line in rendered.split("\n")}
            assert len(widths) == 1
            assert "hey" in rendered
        return store

    asyncio.run(drive())


def test_all_tui_modules_import_cleanly():
    """The TUI entry chain is lazily imported — a broken module would silently
    fall back to the classic REPL. Import everything so that never happens."""
    import importlib

    for name in [
        "grace.cli.tui.app",
        "grace.cli.tui.store",
        "grace.cli.tui.runner",
        "grace.cli.tui.events",
        "grace.cli.tui.index",
        "grace.cli.tui.commands_tui",
    ]:
        importlib.import_module(name)


def test_header_shows_model_and_session_status():
    async def drive():
        store, runner, app = _make()
        async with app.run_test():
            header = app._render_header()
            assert "GRACE" in header
            assert "gpt-oss-20b" in header
        return store

    asyncio.run(drive())
