"""Tests for clipboard paste functionality (Ctrl+V support)."""

from unittest.mock import MagicMock, patch
from grace.cli.tui.clipboard import paste_from_clipboard


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

    def test_ctrl_v_inserts_characters(self):
        """_paste_from_clipboard should insert each character."""
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

        assert store.insert.call_count == 3
        calls = [c[0][0] for c in store.insert.call_args_list]
        assert calls == ["a", "b", "c"]

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
        store.insert.assert_not_called()

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
