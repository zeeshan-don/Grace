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


def _stream_encoding() -> str:
    """The encoding the UI actually writes to (normalized, lower-case)."""
    return (getattr(sys.stdout, "encoding", "") or "").lower().replace("_", "-")


def _windows_console_codepage() -> int | None:
    """The console output code page on Windows, or None when unavailable."""
    if sys.platform != "win32":
        return None
    try:
        import ctypes

        return int(ctypes.windll.kernel32.GetConsoleOutputCP())
    except Exception:
        return None


def supports_unicode(platform: str | None = None) -> bool:
    """True when the terminal renders Unicode glyphs reliably.

    Legacy Windows consoles replace box-drawing glyphs with mojibake or ``?``,
    so ASCII is the safe default *there* — but modern Windows (Windows
    Terminal, VS Code, or a UTF-8 code page) renders every glyph correctly and
    must not be downgraded. The decision follows the real output encoding and
    console code page instead of the platform name alone.
    """
    if os.environ.get("ZEESH_UNICODE") == "1":
        return True
    if os.environ.get("ZEESH_ASCII") == "1":
        return False
    if os.environ.get("WT_SESSION") or os.environ.get("TERM_PROGRAM") or os.environ.get("ConEmuANSI") or os.environ.get("ANSICON"):
        return True
    platform = platform or sys.platform
    if platform != "win32":
        return True
    # Windows: Python writes through the wide console API when attached to a
    # real console (encoding reports UTF-8), and `chcp 65001` does the same for
    # redirected output. Either way the glyphs above are safe to draw.
    if _stream_encoding() in ("utf-8", "utf8", "cp65001"):
        return True
    return _windows_console_codepage() == 65001


def tui_supports_unicode() -> bool:
    """Glyph capability for the Textual TUI.

    Textual draws its own borders and controls through its own console, which
    handles Unicode whatever the host stream encoding is. Mixing Textual's
    Unicode chrome with ASCII inner boxes looks broken, so the TUI always uses
    Unicode unless the user explicitly asks for the ASCII fallback.
    """
    return os.environ.get("ZEESH_ASCII") != "1"


def symbols(platform: str | None = None, force_unicode: bool | None = None) -> dict:
    """Every glyph the UI uses, with a safe ASCII equivalent.

    ``force_unicode`` overrides terminal detection (the TUI passes True so its
    glyphs match Textual's own chrome); an explicit ``ZEESH_ASCII=1`` still
    wins, so the fallback is always reachable.
    """
    if force_unicode is None:
        use_unicode = supports_unicode(platform)
    else:
        use_unicode = bool(force_unicode) and os.environ.get("ZEESH_ASCII") != "1"
    if use_unicode:
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
