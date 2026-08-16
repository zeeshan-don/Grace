"""Small shared text helpers used across tools, context and CLI."""

import math


def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token for mixed source code."""
    return max(1, math.ceil(len(text) / 4))


def truncate_text(text: str, max_chars: int, note: str = "\n… [truncated]") -> str:
    """Truncate long text to maxChars, appending a note so consumers know it was cut."""
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + note


def truncate_middle(text: str, max_chars: int) -> str:
    """Truncate preserving the head and tail (useful for logs/diffs)."""
    if len(text) <= max_chars:
        return text
    half = math.floor(max_chars / 2) - 10
    return f"{text[:half]}\n… [truncated {len(text) - max_chars + 20} chars] …\n{text[-half:]}"


def format_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / (1024 * 1024):.1f} MB"


def format_duration(ms: int) -> str:
    """Render an elapsed duration compactly, e.g. 312ms, 4.2s, 1m 12s."""
    if ms < 1000:
        return f"{ms}ms"
    seconds = ms / 1000
    if seconds < 60:
        return f"{seconds:.1f}s"
    m = math.floor(seconds / 60)
    return f"{m}m {round(seconds % 60)}s"


def short_path(p: str, home: str) -> str:
    """Render an absolute path relative to the user's home directory (or as-is)."""
    if p == home:
        return "~"
    if p.startswith(home + "/") or p.startswith(home + "\\"):
        return "~" + p[len(home):]
    return p
