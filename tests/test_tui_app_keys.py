"""TUI app keyboard tests.

Regression guard: `on_key` read ``event.char``, which Textual >= 8 renamed
to ``event.character`` (``Key.__slots__ == ["key", "character"]``). Every key
press raised ``AttributeError: 'Key' object has no attribute 'char'`` inside
the message handler, crashing the whole TUI back to the shell. A second bug
made the UI thread's own store notifications route through
``call_from_thread`` (which raises ``RuntimeError`` when called on the app
thread), so typed characters never re-rendered on screen.

These tests drive the REAL app through Textual's event loop with real Key
events, exactly the path that crashed in a terminal.
"""

import asyncio

from grace.cli.tui.app import GraceTuiApp
from grace.cli.tui.store import TuiStore


class _StubRunner:
    """Minimal runner double: on_key only needs these methods."""

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
        "workspace": ".",
        "provider": "",
        "providerAvailable": False,
        "model": "",
        "session": "Local mode",
    })
    runner = _StubRunner()
    app = GraceTuiApp(store, runner, lambda: None)
    return store, runner, app


def test_letters_backspace_enter_do_not_crash_and_render():
    async def drive():
        store, runner, app = _make()
        async with app.run_test() as pilot:
            await pilot.press("h", "e", "y")
            assert store.input == "hey"
            # The typed text must be visible: UI-thread store mutations must
            # re-render inline (call_from_thread raises on the app thread).
            assert "hey" in str(app._input.content)

            await pilot.press("backspace")
            assert store.input == "he"

            await pilot.press("enter")
            assert runner.submitted == ["he"]
            assert store.input == ""
        return store

    asyncio.run(drive())


def test_arrows_home_end_tab_scroll_ctrl_l_do_not_crash():
    async def drive():
        store, runner, app = _make()
        async with app.run_test() as pilot:
            await pilot.press("h", "i")
            await pilot.press("left")
            await pilot.press("home")
            await pilot.press("end")

            await pilot.press("tab")
            assert store.focus == "shortcuts"
            await pilot.press("tab")
            assert store.focus == "input"

            for i in range(10):
                store.push("info", f"line {i}")
            await pilot.press("pageup")
            assert store.scroll > 0
            await pilot.press("pagedown")
            assert store.scroll == 0

            await pilot.press("ctrl+l")
            assert store.items == []
        return store

    asyncio.run(drive())


def test_ctrl_c_quits_cleanly():
    async def drive():
        store, runner, app = _make()
        exited = []

        def on_exit():
            exited.append(True)

        app.on_exit = on_exit
        async with app.run_test() as pilot:
            await pilot.press("ctrl+c")
            assert exited == [True]
        return store

    asyncio.run(drive())


def test_overlay_keys_do_not_crash():
    """Palette (typing '/'), help, and login overlays route through on_key."""
    async def drive():
        store, runner, app = _make()
        async with app.run_test() as pilot:
            await pilot.press("/")
            assert store.palette is not None
            await pilot.press("down")
            await pilot.press("escape")
            assert store.palette is None

            store.open_help()
            await pilot.press("q")
            assert store.help_open is False

            store.open_login("login", "")
            await pilot.press("a", "b")
            assert store.login is not None and store.login["email"] == "ab"
            await pilot.press("escape")
            assert store.login is None
        return store

    asyncio.run(drive())
