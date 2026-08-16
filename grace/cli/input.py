"""Terminal input helpers (port of src/cli/input.ts).

`prompt_hidden` reads a line without echoing it to the terminal, used for
passwords during `grace login/register`. Falls back to an empty string in
non-TTY contexts (CI) so callers can handle it gracefully.
"""

import getpass
import sys

try:
    import msvcrt  # Windows raw terminal input
except ImportError:  # pragma: no cover - POSIX
    msvcrt = None


def prompt_text(question: str) -> str:
    """Read a visible line of input (email, names)."""
    try:
        return input(question).strip()
    except (EOFError, KeyboardInterrupt):
        return ""


def prompt_hidden(question: str) -> str:
    """Read a line without echoing (passwords). Empty string when not a TTY."""
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        return ""
    try:
        sys.stdout.write(question)
        sys.stdout.flush()
        if msvcrt is not None:
            # Windows: read keys manually so we can echo nothing at all.
            import msvcrt as _msvcrt

            value = ""
            while True:
                ch = _msvcrt.getwch()
                if ch in ("\r", "\n"):
                    break
                if ch == "\x03":  # Ctrl+C
                    sys.stdout.write("\n")
                    return ""
                if ch in ("\x08", "\x7f"):  # backspace
                    value = value[:-1]
                    continue
                value += ch
            sys.stdout.write("\n")
            return value
        # POSIX: getpass hides input natively.
        return getpass.getpass("")
    except (EOFError, KeyboardInterrupt):
        return ""
