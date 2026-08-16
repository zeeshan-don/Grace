"""
Verbose mode (GRACE UI).

Normal mode keeps the terminal clean: concise progress, structured result
sections, collapsed long output. Verbose mode adds raw diagnostics — plan
steps, per-agent findings, full token counts, more diff lines — WITHOUT
ever printing secrets (API keys never exist in CLI rendering paths).

State is module-level so the REPL can toggle it at runtime (/verbose) and
the CLI flags (--verbose) can seed it at startup.
"""

import sys

_enabled = False


def set_verbose(value: bool) -> None:
    global _enabled
    _enabled = bool(value)


def toggle_verbose() -> bool:
    global _enabled
    _enabled = not _enabled
    return _enabled


def is_verbose() -> bool:
    return _enabled


def debug_log(*args) -> None:
    """Internal diagnostics (provider failures, tool-call repair, …).

    Normal mode is clean: these lines NEVER reach the terminal or the TUI
    activity feed. Verbose/debug mode prints them (scrubbed at the call site)
    so operators can see exactly what happened. This is the ONLY sink internal
    agent code should use instead of print().
    """
    if not _enabled:
        return
    print(*args, file=sys.stderr)
