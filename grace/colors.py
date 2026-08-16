"""Minimal ANSI color helpers with automatic disabling for non-TTY / NO_COLOR."""

import os
import sys

# Module-level detection mirrors the TS `const useColor` evaluated at import
# time. Tests can override with set_color_enabled().
_use_color = bool(sys.stdout.isatty()) and not os.environ.get("NO_COLOR") and os.environ.get("TERM") != "dumb"

_CODES = {
    "reset": "\x1b[0m",
    "dim": "\x1b[2m",
    "bold": "\x1b[1m",
    "red": "\x1b[31m",
    "green": "\x1b[32m",
    "yellow": "\x1b[33m",
    "blue": "\x1b[34m",
    "magenta": "\x1b[35m",
    "cyan": "\x1b[36m",
    "gray": "\x1b[90m",
}


def _paint(code: str, text: str) -> str:
    if not _use_color:
        return text
    return _CODES[code] + text + _CODES["reset"]


def set_color_enabled(enabled: bool) -> None:
    """Test hook: force color rendering on/off regardless of TTY detection."""
    global _use_color
    _use_color = bool(enabled)


class _Color:
    """Namespace of paint helpers mirroring the TS `c` object."""

    def dim(self, t): return _paint("dim", t)
    def bold(self, t): return _paint("bold", t)
    def red(self, t): return _paint("red", t)
    def green(self, t): return _paint("green", t)
    def yellow(self, t): return _paint("yellow", t)
    def blue(self, t): return _paint("blue", t)
    def magenta(self, t): return _paint("magenta", t)
    def cyan(self, t): return _paint("cyan", t)
    def gray(self, t): return _paint("gray", t)


c = _Color()

is_tty = bool(sys.stdout.isatty() and sys.stdin.isatty())
