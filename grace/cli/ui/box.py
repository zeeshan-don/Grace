"""Box/layout helpers (port of src/cli/ui/box.ts).

Small composable pieces — divider, section headers, label/value rows and
multi-line boxes (used only for the compact startup logo) — built on the
capability-aware theme so they degrade gracefully on legacy terminals.

There is deliberately NO input box: the terminal prompt itself is the input
surface (`grace>`), so nothing in the UI draws a fake textbox.
"""

from grace.cli.ui.theme import symbols, theme


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
    """
    opts = opts or {}
    sym = symbols()
    width = _clamp(opts.get("width") or 44, 30, 76)
    inner = width - 4  # space + content + space inside the border
    rows = []
    for line in lines:
        visible = f"{line[:inner - 1]}{sym['ellipsis']}" if len(line) > inner else line
        padded = visible.rjust((inner + len(visible)) // 2).ljust(inner)
        rows.append(f"{sym['vLine']} {padded} {sym['vLine']}")
    return "\n".join([
        f"{sym['cornerTl']}{sym['hLine'] * (width - 2)}{sym['cornerTr']}",
        *rows,
        f"{sym['cornerBl']}{sym['hLine'] * (width - 2)}{sym['cornerBr']}",
    ])
