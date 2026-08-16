"""GRACE TUI entry (Textual port of src/cli/tui/index.ts).

`grace` on a TTY enters here: the terminal switches to the alternate screen
buffer, a real interactive app renders (Textual), and on exit the previous
terminal content is restored. stdout/stderr are redirected into the activity
feed while the TUI runs (existing command output becomes scrollable history);
everything is restored on teardown.
"""

import contextlib
import io
import signal
import sys

from grace.cli.tui.app import GraceTuiApp
from grace.cli.tui.info import build_tui_info, refresh_free_plan
from grace.cli.tui.runner import TuiRunner
from grace.cli.tui.store import TuiStore
from grace.config import load_env
from grace.meta import VERSION
from grace.runtime import create_runtime
from grace.verbose import is_verbose, set_verbose


class _FeedWriter(io.TextIOBase):
    """Redirect console output into the activity feed (ANSI-free, line-based)."""

    def __init__(self, store, kind: str) -> None:
        self.store = store
        self.kind = kind
        self._buffer = ""

    def write(self, text: str) -> int:
        if not text:
            return 0
        self._buffer += text
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            self._flush_line(line)
        return len(text)

    def _flush_line(self, line: str) -> None:
        stripped = line.rstrip()
        if not stripped:
            return
        # Defense in depth: internal `[grace:…]` diagnostics are debug-only.
        if not is_verbose() and stripped.lstrip().startswith("[grace:"):
            return
        self.store.push(self.kind, stripped)

    def flush(self) -> None:
        if self._buffer:
            self._flush_line(self._buffer)
            self._buffer = ""


def run_tui(root: str, opts: dict | None = None) -> int:
    """Launch the full-screen GRACE interface. Resolves when the user exits."""
    opts = opts or {}
    load_env(root)
    if opts.get("verbose"):
        set_verbose(True)

    store = TuiStore({
        "version": VERSION,
        "workspace": root,
        "provider": "",
        "providerAvailable": False,
        "model": "",
        "session": "Local mode",
    })

    def make_runtime(r: str):
        return create_runtime(r, {"yes": opts.get("yes", False), "model": opts.get("model"), "ask": store.ask_permission})

    runtime = make_runtime(root)
    store.info = build_tui_info(runtime)

    try:
        line = refresh_free_plan()
        if line:
            store.info["freePlan"] = line
            store.notify()
    except Exception:
        pass

    exit_requested = [False]

    def request_exit():
        if exit_requested[0]:
            return
        exit_requested[0] = True
        app.exit()

    runner = TuiRunner({
        "runtime": runtime,
        "store": store,
        "makeRuntime": make_runtime,
        "onExit": request_exit,
    })

    app = GraceTuiApp(store, runner, request_exit)

    # Redirect console output into the activity feed while the TUI owns the
    # screen (slash commands, auth output, agent notes). Restored on teardown.
    original_stdout = sys.stdout
    original_stderr = sys.stderr
    sys.stdout = _FeedWriter(store, "console")
    sys.stderr = _FeedWriter(store, "error")

    def on_sigint(signum, frame):
        if runner.is_busy():
            runner.cancel_task()
        else:
            request_exit()

    previous_handler = None
    try:
        previous_handler = signal.signal(signal.SIGINT, on_sigint)
        app.run()
    finally:
        if previous_handler is not None:
            signal.signal(signal.SIGINT, previous_handler)
        sys.stdout = original_stdout
        sys.stderr = original_stderr

    return 0
