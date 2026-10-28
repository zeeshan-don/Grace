"""Box/layout helpers (port of src/cli/ui/box.ts).

Small composable pieces — divider, section headers, label/value rows and
multi-line boxes (used only for the compact startup logo) — built on the
capability-aware theme so they degrade gracefully on legacy terminals.

There is deliberately NO input box: the terminal prompt itself is the input
surface (`grace>`), so nothing in the UI draws a fake textbox.
"""

from grace.cli.ui.theme import strip_ansi, symbols, theme, visual_width


def divider(width: int = 48) -> str:
    """Full-width horizontal divider, e.g. ────────────────."""
    sym = symbols()
    return sym["hLine"] * max(8, width)


def section(title: str) -> str:
    """Section header, e.g. \"Files changed\"."""
    return theme()["bold"](title)


def kv(label: str, value: str, pad: int = 10) -> str:
    """One aligned label/value row, e.g. \"Directory  D:\\Projects\\app\".
    The default padding keeps values aligned at column 12 (banner)."""
    th = theme()
    return f"  {th['label'](label.ljust(pad))}{value}"


def _clamp(n: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, n))


def box(line: str, opts: dict | None = None) -> str:
    """Render a single-line box."""
    return box_lines([line], opts or {})


def box_lines(lines: list[str], opts: dict | None = None) -> str:
    """Render a multi-line box with every line centered:
        ┌─────────────────────────────┐
        │            GRACE            │
        │  AI Coding Agent · v0.1.0   │
        └─────────────────────────────┘

    Widths are measured on VISIBLE text — ANSI colour codes are zero-width, so
    padding with ``len()`` pushed coloured content left and left the borders
    ragged on every real terminal (the tests run with colour off and missed it).
    """
    opts = opts or {}
    sym = symbols()
    width = _clamp(opts.get("width") or 44, 30, 76)
    inner = width - 4  # space + content + space inside the border
    rows = []
    for line in lines:
        if visual_width(line) > inner:
            # Truncate the plain text: slicing coloured text could cut an escape
            # sequence in half and leak raw codes to the terminal.
            line = strip_ansi(line)[: max(0, inner - 1)] + sym["ellipsis"]
        pad_total = max(0, inner - visual_width(line))
        left = pad_total // 2
        padded = " " * left + line + " " * (pad_total - left)
        rows.append(f"{sym['vLine']} {padded} {sym['vLine']}")
    return "\n".join([
        f"{sym['cornerTl']}{sym['hLine'] * (width - 2)}{sym['cornerTr']}",
        *rows,
        f"{sym['cornerBl']}{sym['hLine'] * (width - 2)}{sym['cornerBr']}",
    ])
