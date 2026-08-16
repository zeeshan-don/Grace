"""GRACE wordmark (TUI home screen) — port of src/cli/tui/logo.ts.

The hero logo is the exact block letters from GRACE_logo.txt — never redrawn
or "improved". The file's uniform indentation is removed and each row is kept
exactly as drawn.
"""

from grace.cli.ui.theme import supports_unicode

# The GRACE logo exactly as drawn in GRACE_logo.txt (common indent removed).
LOGO_ROWS = [
    "██████╗ ██████╗  █████╗  ██████╗███████╗",
    "██╔════╝ ██╔══██╗██╔══██╗██╔════╝██╔════╝",
    "██║  ███╗██████╔╝███████║██║     █████╗",
    "██║   ██║██╔══██╗██╔══██║██║     ██╔══╝",
    "╚██████╔╝██║  ██║██║  ██║╚██████╗███████╗",
    " ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚══════╝",
]

# Legacy fallback: the same letterforms, every glyph replaced 1:1 with '#'.
LOGO_ROWS_ASCII = ["".join("#" if ch != " " else " " for ch in row) for row in LOGO_ROWS]

COMPACT = ["G   R   A   C   E"]


def _cell_width(text: str) -> int:
    """Real terminal width of a logo row: the █ block is two cells, the
    box-drawing corners and spaces are one."""
    w = 0
    for ch in text:
        w += 2 if ch == "█" else 1
    return w


def logo_lines() -> list[str]:
    return list(LOGO_ROWS) if supports_unicode() else list(LOGO_ROWS_ASCII)


def logo_width() -> int:
    return max(_cell_width(row) for row in logo_lines())


def compact_lines() -> list[str]:
    return list(COMPACT)


def choose_logo_for(columns: int, rows: int) -> dict:
    """The best logo for a terminal: the full six-row logo when it fits,
    otherwise the compact wordmark."""
    full = logo_lines()
    full_width = logo_width()
    if rows >= 13 and columns >= full_width + 2:
        return {"lines": full, "width": full_width}
    compact = compact_lines()
    return {"lines": compact, "width": max(len(l) for l in compact)}


def wordmark() -> str:
    return "GRACE"
