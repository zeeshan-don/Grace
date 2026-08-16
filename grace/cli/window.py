"""`grace --new-window` — open Grace in a separate terminal window (port of
src/cli/window.ts).

The current working directory is preserved as the workspace: the new window
runs the exact same `grace` REPL against the directory the command was
executed in.

  - Windows: Windows Terminal (`wt.exe`) when available, otherwise a new
    PowerShell console window (detached → its own window).
  - macOS: a new Terminal.app window via AppleScript.
  - Linux: best-effort — gnome-terminal, konsole, xfce4-terminal, xterm.

The launch is best-effort: if nothing can spawn a window the caller gets
`False` and falls back to running in the current terminal.
"""

import os
import subprocess
import sys

from grace.colors import c


def _ps_quote(path: str) -> str:
    return path.replace("'", "''")


def _sh_quote(path: str) -> str:
    return path.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$").replace("`", "\\`")


def launch_in_new_window(root: str) -> bool:
    """Launch a new terminal window running `grace` in `root`. True when a
    window was spawned, False when it could not be launched."""
    # The running entry: python -m grace (or the installed grace script).
    entry = os.path.abspath(sys.argv[0] if sys.argv and sys.argv[0] else "")
    if not entry:
        return False
    run_cmd = f"& '{_ps_quote(entry)}'"
    if sys.platform == "win32":
        return _launch_windows(root, run_cmd)
    if sys.platform == "darwin":
        return _launch_mac(root, run_cmd)
    return _launch_linux(root, run_cmd)


def _launch_windows(root: str, run_cmd: str) -> bool:
    ps = f"Set-Location -LiteralPath '{_ps_quote(root)}'; {run_cmd}"
    if _try_spawn("wt.exe", ["-d", root, "powershell", "-NoExit", "-Command", ps]):
        return True
    return _try_spawn("powershell.exe", ["-NoExit", "-Command", ps])


def _launch_mac(root: str, run_cmd: str) -> bool:
    script = f'tell application "Terminal" to do script "cd \\"{_sh_quote(root)}\\" && {run_cmd}"'
    return _try_spawn("osascript", ["-e", script])


def _launch_linux(root: str, run_cmd: str) -> bool:
    shell = f'cd "{_sh_quote(root)}" && {run_cmd}'
    candidates = [
        ("gnome-terminal", lambda d, cmd: ["--working-directory=" + d, "--", "bash", "-lc", cmd]),
        ("konsole", lambda d, cmd: ["--workdir", d, "-e", "bash", "-lc", cmd]),
        ("xfce4-terminal", lambda d, cmd: ["--working-directory=" + d, "-e", f'bash -lc "{cmd}"']),
        ("xterm", lambda _d, cmd: ["-e", "bash", "-lc", cmd]),
    ]
    for bin_name, args_fn in candidates:
        if _try_spawn(bin_name, args_fn(root, shell)):
            return True
    return False


def _try_spawn(bin_name: str, args: list[str]) -> bool:
    try:
        subprocess.Popen([bin_name, *args], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, close_fds=True)
        return True
    except Exception:
        return False


def new_window_notice(root: str) -> str:
    return f"{c.green('Opening a new window for:')} {c.blue(root)}"
