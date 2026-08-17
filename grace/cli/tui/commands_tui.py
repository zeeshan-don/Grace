"""TUI slash command handlers (port of src/cli/tui/commands-tui.ts).

Every command is REAL — the same backend logic as the piped REPL. Commands
with interactive surfaces (model/provider pickers, login overlay, help,
clear) are handled natively here; the rest print through console which the
app routes into the activity feed.
"""

import os

from grace.cli.auth_commands import cmd_logout, cmd_whoami
from grace.cli.commands import (
    cmd_diff,
    cmd_model,
    cmd_provider,
    cmd_reset,
    cmd_status,
    cmd_undo,
)
from grace.verbose import is_verbose, set_verbose, toggle_verbose


def handle_tui_slash(runner, store, cmd: str, arg: str) -> bool:
    """Execute a slash command. Returns True when Grace should exit."""
    runtime = runner.get_runtime()

    if cmd == "/help":
        store.open_help()
        return False

    if cmd == "/model":
        if not arg.strip():
            runner.open_model_picker()
        else:
            cmd_model(runtime, arg)
            runner.refresh_info()
        return False

    if cmd == "/provider":
        if not arg.strip():
            runner.open_provider_picker()
        else:
            cmd_provider(runtime, arg)
            runner.refresh_info()
        return False

    if cmd == "/cd":
        directory = arg.strip()
        if not directory:
            store.push("error", "Usage: /cd <directory>")
            return False
        target = os.path.abspath(os.path.join(runtime.root, directory))
        if not os.path.isdir(target):
            store.push("error", f"Not a directory: {target}")
            return False
        next_runtime = runner.make_runtime(target)
        runner.set_runtime(next_runtime)
        runner.refresh_info()
        store.push("success", "Workspace changed.")
        store.push("info", f"Workspace: {next_runtime.root}")
        return False

    if cmd == "/clear":
        store.clear_activity()
        return False

    if cmd == "/login":
        store.open_login("login", arg)
        return False

    if cmd == "/register":
        store.open_login("register", arg)
        return False

    if cmd == "/status":
        cmd_status(runtime)
        return False

    if cmd == "/diff":
        cmd_diff(runtime)
        return False

    if cmd == "/reset":
        cmd_reset(runtime)
        return False

    if cmd == "/undo":
        cmd_undo(runtime)
        return False

    if cmd == "/debug":
        mode = arg.strip().lower()
        if mode == "on":
            set_verbose(True)
        elif mode == "off":
            set_verbose(False)
        else:
            toggle_verbose()
        store.push("info", f"Debug mode: {'on' if is_verbose() else 'off'}.")
        return False

    if cmd == "/verbose":
        store.push("info", f"Debug mode: {'on' if toggle_verbose() else 'off'}.")
        return False

    if cmd == "/logout":
        cmd_logout()
        runner.refresh_info()
        return False

    if cmd == "/whoami":
        cmd_whoami()
        runner.refresh_info()
        return False

    if cmd in ("/exit", "/quit"):
        return True

    store.push("error", f'Unknown command "{cmd}". Type /help for the list.')
    return False
