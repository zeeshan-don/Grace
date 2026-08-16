"""Terminal capability detection + semantic styling (port of src/cli/ui/theme.ts).

Everything here reads the environment at CALL time (never at module load) so
the render helpers can be unit-tested in any terminal state. Two capabilities
drive all rendering:

 - ANSI color: reuse `c` from grace/colors.py (auto-disabled for non-TTY /
   NO_COLOR / TERM=dumb).
 - Unicode glyphs: box-drawing, check marks, arrows and braille spinners
   degrade to ASCII on legacy terminals. Override with ZEESH_UNICODE=1 /
   ZEESH_ASCII=1.
"""

import os
import re
import sys

from grace.colors import c

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def supports_ansi() -> bool:
    return bool(sys.stdout.isatty()) and not os.environ.get("NO_COLOR") and os.environ.get("TERM") != "dumb"


def supports_unicode(platform: str | None = None) -> bool:
    """True when the terminal renders Unicode glyphs reliably."""
    if os.environ.get("ZEESH_UNICODE") == "1":
        return True
    if os.environ.get("ZEESH_ASCII") == "1":
        return False
    if os.environ.get("WT_SESSION") or os.environ.get("TERM_PROGRAM") or os.environ.get("ConEmuANSI") or os.environ.get("ANSICON"):
        return True
    platform = platform or sys.platform
    return platform != "win32"


def symbols(platform: str | None = None) -> dict:
    """Every glyph the UI uses, with a safe ASCII equivalent."""
    if supports_unicode(platform):
        return {
            "check": "✓",
            "cross": "✗",
            "warn": "!",
            "bullet": "·",
            "dot": "•",
            "arrow": "→",
            "ellipsis": "…",
            "cornerTl": "┌",
            "cornerTr": "┐",
            "cornerBl": "└",
            "cornerBr": "┘",
            "hLine": "─",
            "vLine": "│",
            "mid": "├",
            "spinner": ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
        }
    return {
        "check": "[ok]",
        "cross": "[x]",
        "warn": "[!]",
        "bullet": "-",
        "dot": "*",
        "arrow": "->",
        "ellipsis": "...",
        "cornerTl": "+",
        "cornerTr": "+",
        "cornerBl": "+",
        "cornerBr": "+",
        "hLine": "-",
        "vLine": "|",
        "mid": "+",
        "spinner": ["|", "/", "-", "\\"],
    }


def theme() -> dict:
    """Semantic theme bound to the current terminal (no-ops when color is off)."""
    return {
        "success": c.green,
        "error": c.red,
        "warn": c.yellow,
        "info": c.cyan,
        "dim": c.dim,
        "bold": c.bold,
        "label": c.dim,
        "agent": c.yellow,
        "provider": c.cyan,
        "model": c.magenta,
        "command": c.cyan,
        "path": c.blue,
        "number": c.yellow,
    }


def strip_ansi(text: str) -> str:
    """Strip ANSI escape sequences (used for width math and test assertions)."""
    return _ANSI_RE.sub("", text)


def visual_width(text: str) -> int:
    """Visible width of a string on the terminal (approximate, code-point based)."""
    return len(strip_ansi(text))
