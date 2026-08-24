"""Tests for clipboard paste functionality (Ctrl+V support).

Covers:
- Subprocess clipboard reads (Windows/macOS/Linux)
- on_key routing for Ctrl+V
- on_paste event handler (Textual bracketed paste)
- Batch paste_text on TuiStore
- Large-prompt regression (no chars lost/duplicated, Unicode preserved)
- Keyboard behavior (Ctrl+C, Enter, Escape)
"""

import asyncio
from unittest.mock import MagicMock, patch

from grace.cli.tui.clipboard import paste_from_clipboard


# ---------------------------------------------------------------------------
# Subprocess clipboard reads
# ---------------------------------------------------------------------------

class TestPasteFromClipboard:
    """Verify paste_from_clipboard reads from system clipboard."""

    @patch("grace.cli.tui.clipboard.platform.system", return_value="Windows")
    @patch("grace.cli.tui.clipboard.subprocess.run")
    def test_windows_paste(self, mock_run, _platform):
        mock_run.return_value = MagicMock(returncode=0, stdout=b"hello world")
        result = paste_from_clipboard()
        assert result == "hello world"
        mock_run.assert_called_once()
        cmd = mock_run.call_args[0][0]
        assert "Get-Clipboard" in " ".join(cmd)

    @patch("grace.cli.tui.clipboard.platform.system", return_value="Windows")
    @patch("grace.cli.tui.clipboard.subprocess.run")
    def test_windows_paste_strips_newlines(self, mock_run, _platform):
        mock_run.return_value = MagicMock(returncode=0, stdout=b"hello\r\n")
        result = paste_from_clipboard()
        assert result == "hello"

    @patch("grace.cli.tui.clipboard.platform.system", return_value="Windows")
    @patch("grace.cli.tui.clipboard.subprocess.run")
    def test_windows_paste_failure(self, mock_run, _platform):
        mock_run.return_value = MagicMock(returncode=1, stdout=b"")
        result = paste_from_clipboard()
        assert result == ""

    @patch("grace.cli.tui.clipboard.platform.system", return_value="Darwin")
    @patch("grace.cli.tui.clipboard.subprocess.run")
    def test_macos_paste(self, mock_run, _platform):
        mock_run.return_value = MagicMock(returncode=0, stdout=b"mac text")
        result = paste_from_clipboard()
        assert result == "mac text"
        cmd = mock_run.call_args[0][0]
        assert cmd == ["pbpaste"]

    @patch("grace.cli.tui.clipboard.platform.system", return_value="Linux")
    @patch("grace.cli.tui.clipboard.subprocess.run")
    def test_linux_paste_xclip(self, mock_run, _platform):
        mock_run.return_value = MagicMock(returncode=0, stdout=b"linux text")
        result = paste_from_clipboard()
        assert result == "linux text"
        cmd = mock_run.call_args[0][0]
        assert "xclip" in cmd

    @patch("grace.cli.tui.clipboard.subprocess.run")
    def test_empty_clipboard(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout=b"")
        result = paste_from_clipboard()
        assert result == ""

    @patch("grace.cli.tui.clipboard.subprocess.run", side_effect=Exception("fail"))
    def test_exception_returns_empty(self, mock_run):
        result = paste_from_clipboard()
        assert result == ""


# ---------------------------------------------------------------------------
# on_key routing for Ctrl+V
# ---------------------------------------------------------------------------

class TestKeyBindingRoutesCtrlV:
    """Verify the on_key handler routes ctrl+v to the paste method."""

    def test_ctrl_v_calls_paste(self):
        """Ctrl+V should call _paste_from_clipboard, not insert 'v'."""
        from grace.cli.tui.app import GraceTuiApp

        store = MagicMock()
        store.permission = None
        store.picker = None
        store.login = None
        store.help_open = None
        store.palette = None
        runner = MagicMock()

        app = GraceTuiApp(store, runner, lambda: None)
        app._paste_from_clipboard = MagicMock()

        event = MagicMock()
        event.key = "ctrl+v"
        event.character = None

        app.on_key(event)

        app._paste_from_clipboard.assert_called_once()
        event.stop.assert_called_once()

    def test_ctrl_v_uses_batch_paste_text(self):
        """_paste_from_clipboard should call store.paste_text (batch), not
        store.insert per character."""
        from grace.cli.tui.app import GraceTuiApp

        store = MagicMock()
        store.permission = None
        store.picker = None
        store.login = None
        store.help_open = None
        store.palette = None
        runner = MagicMock()

        app = GraceTuiApp(store, runner, lambda: None)

        with patch("grace.cli.tui.app.paste_from_clipboard", return_value="abc"):
            app._paste_from_clipboard()

        store.paste_text.assert_called_once_with("abc")
        store.insert.assert_not_called()

    def test_ctrl_v_ignored_when_overlay_active(self):
        """Paste should not work when a permission overlay is shown."""
        from grace.cli.tui.app import GraceTuiApp

        store = MagicMock()
        store.permission = {"command": "rm -rf /"}
        store.picker = None
        store.login = None
        store.help_open = None
        store.palette = None
        runner = MagicMock()

        app = GraceTuiApp(store, runner, lambda: None)

        with patch("grace.cli.tui.app.paste_from_clipboard", return_value="abc") as mock_paste:
            app._paste_from_clipboard()

        mock_paste.assert_not_called()
        store.paste_text.assert_not_called()

    def test_ctrl_v_ignored_when_picker_active(self):
        """Paste should not work when a picker overlay is shown."""
        from grace.cli.tui.app import GraceTuiApp

        store = MagicMock()
        store.permission = None
        store.picker = {"kind": "model", "options": []}
        store.login = None
        store.help_open = None
        store.palette = None
        runner = MagicMock()

        app = GraceTuiApp(store, runner, lambda: None)

        with patch("grace.cli.tui.app.paste_from_clipboard", return_value="abc") as mock_paste:
            app._paste_from_clipboard()

        mock_paste.assert_not_called()

    def test_ctrl_v_ignored_when_palette_active(self):
        """Paste should not work when the command palette is open."""
        from grace.cli.tui.app import GraceTuiApp

        store = MagicMock()
        store.permission = None
        store.picker = None
        store.login = None
        store.help_open = None
        store.palette = {"commands": [], "query": "/", "selected": 0}
        runner = MagicMock()

        app = GraceTuiApp(store, runner, lambda: None)

        with patch("grace.cli.tui.app.paste_from_clipboard", return_value="abc") as mock_paste:
            app._paste_from_clipboard()

        mock_paste.assert_not_called()

    def test_regular_v_does_not_paste(self):
        """Pressing 'v' alone should just insert 'v', not paste."""
        from grace.cli.tui.app import GraceTuiApp

        store = MagicMock()
        store.permission = None
        store.picker = None
        store.login = None
        store.help_open = None
        store.palette = None
        store.focus = "input"
        runner = MagicMock()

        app = GraceTuiApp(store, runner, lambda: None)
        app._paste_from_clipboard = MagicMock()

        event = MagicMock()
        event.key = "v"
        event.character = "v"

        app.on_key(event)

        app._paste_from_clipboard.assert_not_called()
        store.insert.assert_called_once_with("v")


# ---------------------------------------------------------------------------
# on_paste event handler (Textual bracketed paste)
# ---------------------------------------------------------------------------

class TestOnPasteEvent:
    """Verify the on_paste handler receives Textual Paste events."""

    def test_on_paste_inserts_text(self):
        """on_paste should call store.paste_text with the event text."""
        from grace.cli.tui.app import GraceTuiApp

        store = MagicMock()
        store.permission = None
        store.picker = None
        store.login = None
        store.help_open = None
        store.palette = None
        runner = MagicMock()

        app = GraceTuiApp(store, runner, lambda: None)

        event = MagicMock()
        event.text = "hello world"

        app.on_paste(event)

        store.paste_text.assert_called_once_with("hello world")

    def test_on_paste_ignored_when_empty(self):
        """on_paste should do nothing for empty text."""
        from grace.cli.tui.app import GraceTuiApp

        store = MagicMock()
        runner = MagicMock()

        app = GraceTuiApp(store, runner, lambda: None)

        event = MagicMock()
        event.text = ""

        app.on_paste(event)

        store.paste_text.assert_not_called()

    def test_on_paste_ignored_when_none(self):
        """on_paste should do nothing when event.text is None."""
        from grace.cli.tui.app import GraceTuiApp

        store = MagicMock()
        runner = MagicMock()

        app = GraceTuiApp(store, runner, lambda: None)

        event = MagicMock()
        event.text = None

        app.on_paste(event)

        store.paste_text.assert_not_called()

    def test_on_paste_ignored_when_overlay_active(self):
        """Paste should not work when a permission overlay is shown."""
        from grace.cli.tui.app import GraceTuiApp

        store = MagicMock()
        store.permission = {"command": "rm -rf /"}
        store.picker = None
        store.login = None
        store.help_open = None
        store.palette = None
        runner = MagicMock()

        app = GraceTuiApp(store, runner, lambda: None)

        event = MagicMock()
        event.text = "should not paste"

        app.on_paste(event)

        store.paste_text.assert_not_called()

    def test_on_paste_inserts_multiline(self):
        """on_paste should handle multiline paste text."""
        from grace.cli.tui.app import GraceTuiApp

        store = MagicMock()
        store.permission = None
        store.picker = None
        store.login = None
        store.help_open = None
        store.palette = None
        runner = MagicMock()

        app = GraceTuiApp(store, runner, lambda: None)

        multiline = "line 1\nline 2\nline 3"
        event = MagicMock()
        event.text = multiline

        app.on_paste(event)

        store.paste_text.assert_called_once_with(multiline)


# ---------------------------------------------------------------------------
# TuiStore.paste_text — batch insert
# ---------------------------------------------------------------------------

class TestStorePasteText:
    """Verify TuiStore.paste_text inserts at cursor and notifies once."""

    def test_paste_text_basic(self):
        from grace.cli.tui.store import TuiStore

        store = TuiStore({"workspace": "."})
        store.paste_text("hello")
        assert store.input == "hello"
        assert store.cursor == 5

    def test_paste_text_at_cursor(self):
        from grace.cli.tui.store import TuiStore

        store = TuiStore({"workspace": "."})
        store.insert("h")
        store.insert("l")
        store.move_left()  # cursor between h and l
        store.paste_text("e")
        assert store.input == "hel"
        assert store.cursor == 2

    def test_paste_text_empty(self):
        from grace.cli.tui.store import TuiStore

        store = TuiStore({"workspace": "."})
        store.paste_text("")
        assert store.input == ""
        assert store.cursor == 0

    def test_paste_text_unicode(self):
        from grace.cli.tui.store import TuiStore

        store = TuiStore({"workspace": "."})
        store.paste_text("こんにちは 🌍 café")
        assert store.input == "こんにちは 🌍 café"
        assert store.cursor == len("こんにちは 🌍 café")

    def test_paste_text_triggers_single_notify(self):
        from grace.cli.tui.store import TuiStore

        store = TuiStore({"workspace": "."})
        count = [0]

        def on_change():
            count[0] += 1

        store.subscribe(on_change)
        store.paste_text("abcde")
        assert count[0] == 1  # single notification, not one per char

    def test_paste_text_newlines_preserved(self):
        from grace.cli.tui.store import TuiStore

        store = TuiStore({"workspace": "."})
        text = "line1\nline2\nline3"
        store.paste_text(text)
        assert store.input == text


# ---------------------------------------------------------------------------
# Large-prompt regression test
# ---------------------------------------------------------------------------

class TestLargePromptPaste:
    """Regression: pasting a large prompt must arrive intact."""

    # A realistic coding-agent prompt with Unicode, code, special chars,
    # and multiline content.
    LARGE_PROMPT = """\
Please refactor the following Python module to use async/await:

```python
import json
from typing import List, Dict

class DataProcessor:
    def __init__(self, config_path: str):
        with open(config_path) as f:
            self.config = json.load(f)

    def process_items(self, items: List[Dict]) -> List[Dict]:
        results = []
        for item in items:
            if item.get("status") == "active":
                transformed = self.transform(item)
                results.append(transformed)
        return results

    def transform(self, item: Dict) -> Dict:
        return {
            "id": item["id"],
            "name": item["name"].strip(),
            "score": round(item.get("score", 0) * 1.5, 2),
            "tags": [t.lower() for t in item.get("tags", [])],
            "metadata": {"processed": True, "version": "2.0"},
        }
```

Requirements:
1. Convert to `async def` with `aiofiles` for file I/O
2. Add type hints for the async methods
3. Use `asyncio.gather` for parallel processing
4. Keep the existing test suite passing (ñ, é, ü, 中文, 🎉, Ω, ∑)
5. Handle edge cases: empty items, missing keys, Unicode file paths (café.txt)
"""

    def test_large_prompt_paste_integrity(self):
        """Paste a large prompt via on_paste and verify every character."""
        from grace.cli.tui.app import GraceTuiApp
        from grace.cli.tui.store import TuiStore

        info = {
            "workspace": ".",
            "provider": "",
            "providerAvailable": False,
            "model": "",
            "session": "Local mode",
        }
        store = TuiStore(info)
        runner = MagicMock()
        app = GraceTuiApp(store, runner, lambda: None)

        event = MagicMock()
        event.text = self.LARGE_PROMPT

        app.on_paste(event)

        assert store.input == self.LARGE_PROMPT
        assert store.cursor == len(self.LARGE_PROMPT)

    def test_large_prompt_no_chars_lost(self):
        """Every character from the paste must be present in the input."""
        from grace.cli.tui.store import TuiStore

        store = TuiStore({"workspace": "."})
        store.paste_text(self.LARGE_PROMPT)

        # No character should be lost
        assert len(store.input) == len(self.LARGE_PROMPT)
        # No character should be duplicated
        assert store.input.count("\n") == self.LARGE_PROMPT.count("\n")
        assert store.input.count("```") == self.LARGE_PROMPT.count("```")

    def test_large_prompt_unicode_survives(self):
        """Unicode characters must survive the paste round-trip."""
        from grace.cli.tui.store import TuiStore

        store = TuiStore({"workspace": "."})
        store.paste_text(self.LARGE_PROMPT)

        # Check specific Unicode sequences
        assert "ñ" in store.input
        assert "é" in store.input
        assert "ü" in store.input
        assert "中文" in store.input
        assert "🎉" in store.input
        assert "Ω" in store.input
        assert "∑" in store.input
        assert "café.txt" in store.input

    def test_large_prompt_via_clipboard_subprocess(self):
        """Paste a large prompt via the clipboard subprocess path."""
        from grace.cli.tui.app import GraceTuiApp
        from grace.cli.tui.store import TuiStore

        info = {
            "workspace": ".",
            "provider": "",
            "providerAvailable": False,
            "model": "",
            "session": "Local mode",
        }
        store = TuiStore(info)
        runner = MagicMock()
        app = GraceTuiApp(store, runner, lambda: None)

        with patch("grace.cli.tui.app.paste_from_clipboard", return_value=self.LARGE_PROMPT):
            app._paste_from_clipboard()

        assert store.input == self.LARGE_PROMPT
        assert store.cursor == len(self.LARGE_PROMPT)

    def test_paste_then_type混合(self):
        """Paste then continue typing — cursor must be at the right position."""
        from grace.cli.tui.store import TuiStore

        store = TuiStore({"workspace": "."})
        store.paste_text("hello world")
        store.move_left()  # before 'd'
        store.insert("X")
        assert store.input == "hello worlXd"

    def test_paste_into_existing_input(self):
        """Paste should append when cursor is at end of existing text."""
        from grace.cli.tui.store import TuiStore

        store = TuiStore({"workspace": "."})
        store.insert("prefix: ")
        store.paste_text("pasted content")
        assert store.input == "prefix: pasted content"
        assert store.cursor == len("prefix: pasted content")


# ---------------------------------------------------------------------------
# Keyboard behavior — using real Textual event loop
# ---------------------------------------------------------------------------

class TestKeyboardBehavior:
    """Drive the real app through Textual's event loop to verify
    Ctrl+V, Ctrl+C, Enter, and Escape behave correctly."""

    def _make_app(self):
        from grace.cli.tui.app import GraceTuiApp
        from grace.cli.tui.store import TuiStore

        info = {
            "workspace": ".",
            "provider": "",
            "providerAvailable": False,
            "model": "",
            "session": "Local mode",
        }
        store = TuiStore(info)
        submitted = []

        class Runner:
            def is_busy(self):
                return False

            def cancel_task(self):
                submitted.append("__cancel__")

            def run_task(self, text):
                submitted.append(text)

            def run_slash(self, text):
                return False

            def push_steering(self, text):
                pass

        runner = Runner()
        app = GraceTuiApp(store, runner, lambda: None)
        return store, runner, app, submitted

    def test_ctrl_v_paste_via_textual(self):
        """Ctrl+V should paste clipboard contents into the input."""
        async def drive():
            store, runner, app, _ = self._make_app()
            async with app.run_test() as pilot:
                # Simulate Ctrl+V — Textual fires Key event
                await pilot.press("ctrl+v")
                # Without a real clipboard, _paste_from_clipboard returns
                # empty and nothing changes — but it must not crash
                assert store.input == ""
            return store

        asyncio.run(drive())

    def test_ctrl_c_idle_does_not_exit(self):
        """Idle Ctrl+C must never exit the TUI — users need Ctrl+C for copy."""
        async def drive():
            store, runner, app, _ = self._make_app()
            exited = []
            app.on_exit = lambda: exited.append(True)
            async with app.run_test() as pilot:
                await pilot.press("ctrl+c")
                assert exited == []
            return store

        asyncio.run(drive())

    def test_enter_submits_input(self):
        """Enter should submit the input and clear it."""
        async def drive():
            store, runner, app, submitted = self._make_app()
            async with app.run_test() as pilot:
                await pilot.press("h", "e", "l", "l", "o")
                assert store.input == "hello"
                await pilot.press("enter")
                assert submitted == ["hello"]
                assert store.input == ""
            return store

        asyncio.run(drive())

    def test_escape_clears_input(self):
        """Escape should clear the input when there is text."""
        async def drive():
            store, runner, app, _ = self._make_app()
            async with app.run_test() as pilot:
                await pilot.press("h", "i")
                assert store.input == "hi"
                await pilot.press("escape")
                assert store.input == ""
            return store

        asyncio.run(drive())

    def test_escape_on_empty_input_moves_to_input_focus(self):
        """Escape on empty input should move focus to input (from shortcuts)."""
        async def drive():
            store, runner, app, _ = self._make_app()
            async with app.run_test() as pilot:
                await pilot.press("tab")  # focus shortcuts
                assert store.focus == "shortcuts"
                await pilot.press("escape")
                assert store.focus == "input"
            return store

        asyncio.run(drive())

    def test_ctrl_l_clears_activity(self):
        """Ctrl+L should clear the activity feed."""
        async def drive():
            store, runner, app, _ = self._make_app()
            store.push("info", "some line")
            async with app.run_test() as pilot:
                await pilot.press("ctrl+l")
                assert store.items == []
            return store

        asyncio.run(drive())

    def test_paste_then_enter_submits(self):
        """Paste text then press Enter should submit the pasted text."""
        async def drive():
            from grace.cli.tui.store import TuiStore
            from grace.cli.tui.app import GraceTuiApp

            info = {
                "workspace": ".",
                "provider": "",
                "providerAvailable": False,
                "model": "",
                "session": "Local mode",
            }
            store = TuiStore(info)
            submitted = []

            class Runner:
                def is_busy(self):
                    return False
                def cancel_task(self):
                    pass
                def run_task(self, text):
                    submitted.append(text)
                def run_slash(self, text):
                    return False
                def push_steering(self, text):
                    pass

            runner = Runner()
            app = GraceTuiApp(store, runner, lambda: None)

            async with app.run_test() as pilot:
                # Simulate on_paste (terminal bracketed paste)
                paste_event = MagicMock()
                paste_event.text = "fix the async bug in processor.py"
                app.on_paste(paste_event)
                assert store.input == "fix the async bug in processor.py"

                await pilot.press("enter")
                assert submitted == ["fix the async bug in processor.py"]
                assert store.input == ""
            return store

        asyncio.run(drive())

    def test_multiple_pastes_append(self):
        """Multiple paste events should concatenate."""
        async def drive():
            from grace.cli.tui.store import TuiStore
            from grace.cli.tui.app import GraceTuiApp

            info = {
                "workspace": ".",
                "provider": "",
                "providerAvailable": False,
                "model": "",
                "session": "Local mode",
            }
            store = TuiStore(info)
            app = GraceTuiApp(store, MagicMock(), lambda: None)

            async with app.run_test() as pilot:
                e1 = MagicMock()
                e1.text = "first "
                app.on_paste(e1)
                assert store.input == "first "

                e2 = MagicMock()
                e2.text = "second"
                app.on_paste(e2)
                assert store.input == "first second"
            return store

        asyncio.run(drive())
