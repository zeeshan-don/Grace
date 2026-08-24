"""Cross-platform clipboard copy (no external dependencies)."""

import platform
import subprocess


def copy_to_clipboard(text: str) -> bool:
    """Copy *text* to the system clipboard. Returns True on success."""
    if not text:
        return False
    system = platform.system()
    try:
        if system == "Windows":
            # powershell Set-Clipboard is the most reliable on Windows.
            proc = subprocess.run(
                ["powershell", "-NoProfile", "-Command", "Set-Clipboard", "-Value", text],
                timeout=5,
                capture_output=True,
            )
            return proc.returncode == 0
        elif system == "Darwin":
            proc = subprocess.run(["pbcopy"], input=text.encode(), timeout=5)
            return proc.returncode == 0
        else:
            # Linux / BSD — try xclip, then xsel.
            for cmd in (
                ["xclip", "-selection", "clipboard"],
                ["xsel", "--clipboard", "--input"],
            ):
                try:
                    proc = subprocess.run(cmd, input=text.encode(), timeout=5)
                    if proc.returncode == 0:
                        return True
                except FileNotFoundError:
                    continue
            return False
    except Exception:
        return False
