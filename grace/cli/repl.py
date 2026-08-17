"""The interactive REPL (port of src/cli/repl.ts).

The terminal itself is the UI — there is no fake textbox drawn around it.
Supports TTY and piped/CI modes, slash commands, permission prompts with
"always allow similar", and Ctrl+C cancellation of in-flight tasks.
"""

import os
import signal
import sys

from grace.auth.client import ApiClient
from grace.auth.session import load_session
from grace.cli.auth_commands import cmd_login, cmd_logout, cmd_register, cmd_whoami
from grace.cli.banner import render_banner
from grace.cli.commands import cmd_clear, cmd_diff, cmd_help, cmd_model, cmd_provider, cmd_reset, cmd_status, cmd_undo
from grace.cli.free_plan import banner_free_plan_line, format_countdown, session_seconds_left
from grace.cli.task_runner import run_task
from grace.cli.ui.box import kv
from grace.cli.ui.theme import theme
from grace.colors import c
from grace.config import load_env
from grace.runtime import create_runtime
from grace.util_text import short_path
from grace.verbose import is_verbose, set_verbose, toggle_verbose

PROMPT = c.bold("grace") + c.cyan("> ")
CONTINUATION_PROMPT = c.cyan("… ")


class _AbortFlag:
    """Minimal abort signal so Ctrl+C cancels an in-flight task safely."""

    def __init__(self) -> None:
        self._aborted = False

    def abort(self) -> None:
        self._aborted = True

    @property
    def aborted(self) -> bool:
        return self._aborted

# Command prefixes the user approved once with "always allow similar".
_approved_prefixes: set[str] = set()

# The in-flight task's abort flag — Ctrl+C cancels it (TTY mode).
_active_task_abort = None


def _command_prefix(command: str) -> str:
    """First word of a command, e.g. \"npm\" from \"npm install jsonwebtoken\"."""
    first = (command.strip().split() or [""])[0]
    return "".join(ch for ch in first if ch.isalnum() or ch in "._-")


def _ask_permission(command: str, reasons: list[str]) -> bool:
    """Permission prompt with y/n/a (always allow similar)."""
    prefix = _command_prefix(command)
    if prefix and prefix in _approved_prefixes:
        return True
    try:
        answer = input(
            f"\n{c.red('! Grace wants to run:')}"
            f"\n\n  {command}"
            f"\n\n{c.yellow(f'Flagged: {'; '.join(reasons)}')}"
            f"\n\n{c.dim('[y] Yes   [n] No   [a] Always allow similar')}"
            f"\n> "
        )
    except (EOFError, KeyboardInterrupt):
        return False
    a = answer.strip().lower()
    if a.startswith("a"):
        if prefix:
            _approved_prefixes.add(prefix)
        return True
    return a.startswith("y")


def _load_banner_free_plan():
    """Fetch the server's daily session state once, briefly. Best-effort only."""
    session = load_session()
    if not session:
        return None
    try:
        return ApiClient(session["apiUrl"], 2000).get_usage(session["token"])
    except Exception:
        return None


def _print_banner(runtime) -> None:
    th = theme()
    session = load_session()
    provider_status = runtime.provider.label if runtime.provider else c.yellow("not configured — add GROQ_API_KEY to .env or run /login")
    model_status = runtime.provider.get_model().id if runtime.provider else th["dim"]("—")
    free_plan = _load_banner_free_plan()

    if session:
        left = None
        if free_plan and free_plan.get("currentSession") is not None and free_plan.get("sessionExpiresAt"):
            left = format_countdown(session_seconds_left(free_plan["sessionExpiresAt"]))
        session_status = c.green(f"logged in as {session['user']['email']}" + (f" · {left} remaining" if left else ""))
    else:
        session_status = c.dim("not logged in — local-only mode (usage tracking off, optional)")

    print(render_banner({
        "directory": short_path(runtime.root, os.path.expanduser("~")),
        "provider": provider_status,
        "model": model_status,
        "session": session_status,
        "freePlan": banner_free_plan_line(free_plan) if free_plan else None,
    }))
    print("")


def _handle_slash(ctx: dict, cmd: str, arg: str) -> bool:
    """Handle one slash command. Returns True when the REPL should exit."""
    runtime = ctx["runtime"]
    if cmd == "/help":
        cmd_help()
    elif cmd == "/model":
        cmd_model(runtime, arg)
    elif cmd == "/provider":
        cmd_provider(runtime, arg)
    elif cmd == "/status":
        cmd_status(runtime)
    elif cmd == "/cd":
        directory = arg.strip()
        if not directory:
            print(c.yellow("Usage: /cd <directory>"))
            return False
        target = os.path.abspath(os.path.join(runtime.root, directory))
        if not os.path.isdir(target):
            print(c.red(f"Not a directory: {target}"))
            return False
        next_runtime = ctx["makeRuntime"](target)
        ctx["runtime"] = next_runtime
        th = theme()
        print(c.green("Workspace changed."))
        print(kv("Workspace", th["path"](next_runtime.root)))
        print(kv("Provider", th["provider"](next_runtime.provider.label) if next_runtime.provider else c.yellow("not configured")))
        print(kv("Model", th["model"](next_runtime.provider.get_model().id) if next_runtime.provider else th["dim"]("—")))
    elif cmd == "/diff":
        cmd_diff(runtime)
    elif cmd == "/clear":
        cmd_clear()
    elif cmd == "/reset":
        cmd_reset(runtime)
    elif cmd == "/undo":
        cmd_undo(runtime)
    elif cmd == "/debug":
        mode = arg.strip().lower()
        if mode == "on":
            set_verbose(True)
        elif mode == "off":
            set_verbose(False)
        else:
            toggle_verbose()
        print(c.green(f"Debug mode: {'on' if is_verbose() else 'off'}."))
    elif cmd == "/verbose":
        print(c.green(f"Debug mode: {'on' if toggle_verbose() else 'off'}."))
    elif cmd == "/login":
        cmd_login(arg)
    elif cmd == "/register":
        cmd_register(arg)
    elif cmd == "/logout":
        cmd_logout()
    elif cmd == "/whoami":
        cmd_whoami()
    elif cmd in ("/exit", "/quit"):
        return True
    else:
        print(c.yellow(f'Unknown command "{cmd}". Type /help for the list.'))
    return False


def _run_loop(ctx: dict, next_task, finish) -> None:
    """Command/agent dispatch loop."""
    while True:
        task = next_task()
        if task is None:
            finish()
            return
        trimmed = task.strip()
        if not trimmed:
            continue

        if trimmed.startswith("/"):
            parts = trimmed.split()
            cmd = parts[0]
            arg = " ".join(parts[1:])
            try:
                should_exit = _handle_slash(ctx, cmd, arg)
                if should_exit:
                    finish()
                    return
            except Exception as err:
                print(c.red(f"Slash command failed unexpectedly: {err}"))
                print(c.dim("Returning to the prompt — try again or run /help."))
            continue

        # A failing task must never kill the session — report the error and
        # return to the prompt. Ctrl+C aborts it.
        global _active_task_abort
        abort = _AbortFlag()
        _active_task_abort = abort
        try:
            run_task(ctx["runtime"], trimmed, {"awaitUsageReport": False, "verbose": is_verbose(), "signal": abort})
        except Exception as err:
            print(c.red(f"Task failed unexpectedly: {err}"))
            print(c.dim("Returning to the prompt — try again or run /help."))
        finally:
            _active_task_abort = None


def run_repl(opts: dict | None = None) -> int:
    opts = opts or {}
    root = os.getcwd()
    load_env(root)
    if opts.get("verbose"):
        set_verbose(True)

    is_tty = bool(sys.stdin.isatty() and sys.stdout.isatty())
    if not is_tty:
        missing = "stdin and stdout" if not (sys.stdin.isatty() or sys.stdout.isatty()) else ("stdin" if not sys.stdin.isatty() else "stdout")
        print(c.dim(
            f"Full-screen interface skipped: {missing} {'are' if missing == 'stdin and stdout' else 'is'} not attached to a terminal here. "
            "Run `grace --new-window` for the full-screen TUI, or launch grace directly in a terminal."
        ), file=sys.stderr)
        return _run_piped(root, opts)
    # The full-screen TUI is loaded lazily so piped/CI mode never depends on it.
    try:
        from grace.cli.tui.index import run_tui

        return run_tui(root, opts)
    except Exception as err:
        print(c.yellow(f"Full-screen interface unavailable ({err}) — using the classic prompt."))
        if opts.get("verbose"):
            # Dev/diagnosis: surface the real traceback instead of hiding it.
            import traceback

            traceback.print_exc()
        return _run_tty(root, opts)


def _run_tty(root: str, opts: dict) -> int:
    def make_runtime(r: str):
        return create_runtime(r, {"yes": opts.get("yes", False), "model": opts.get("model"), "ask": _ask_permission})

    ctx = {"runtime": make_runtime(root), "makeRuntime": make_runtime}

    def on_sigint(signum, frame):
        abort = _active_task_abort
        if abort is not None:
            abort.abort()
            sys.stdout.write("\n" + c.dim("Cancel requested — stopping…") + "\n")
        else:
            print(c.dim("Goodbye."))
            sys.exit(0)

    signal.signal(signal.SIGINT, on_sigint)

    _print_banner(ctx["runtime"])

    def next_task():
        buffer = ""
        first = True
        while True:
            try:
                line = input(PROMPT if first else CONTINUATION_PROMPT)
            except EOFError:
                return None
            except KeyboardInterrupt:
                return None
            if buffer == "" and line.strip() == "":
                continue
            first = False
            if line.rstrip().endswith("\\"):
                buffer += line.rstrip()[:-1] + "\n"
                continue
            buffer += line
            return buffer

    _run_loop(ctx, next_task, lambda: None)
    print(c.dim("Goodbye."))
    return 0


def _run_piped(root: str, opts: dict) -> int:
    def make_runtime(r: str):
        return create_runtime(r, {"yes": opts.get("yes", False), "model": opts.get("model")})

    ctx = {"runtime": make_runtime(root), "makeRuntime": make_runtime}
    _print_banner(ctx["runtime"])

    lines = iter(sys.stdin)

    def next_task():
        try:
            first = next(lines)
        except StopIteration:
            return None
        buffer = first.rstrip("\n")
        while buffer.rstrip().endswith("\\"):
            buffer = buffer.rstrip()[:-1]
            try:
                more = next(lines)
            except StopIteration:
                break
            buffer += "\n" + more.rstrip("\n")
        return buffer

    _run_loop(ctx, next_task, lambda: None)
    print(c.dim("Goodbye."))
    return 0
