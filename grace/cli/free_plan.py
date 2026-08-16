"""GRACE FREE session display helpers (port of src/cli/freePlan.ts).

Pure rendering only — every number comes from the backend's daily session
state (GET /api/usage / POST /api/provider response), so the CLI never trusts
or stores quota locally. All functions degrade gracefully: pass None / invalid
data and they return nothing to print.
"""

import math
from datetime import datetime, timezone

from grace.colors import c


def format_countdown(seconds) -> str:
    """Render seconds as a compact countdown, e.g. 47m 12s ('' when invalid)."""
    if not isinstance(seconds, (int, float)) or seconds != seconds:  # NaN check
        return ""
    total = max(0, math.floor(seconds))
    if total <= 0:
        return "expired"
    m = total // 60
    s = total % 60
    return f"{m}m {s}s" if m > 0 else f"{s}s"


def format_daily_usage(seconds) -> str:
    """Render daily usage totals with hours, e.g. 6h, 1h 35m, 10m, 45s."""
    if not isinstance(seconds, (int, float)) or seconds != seconds or seconds < 0:
        return ""
    total = math.floor(seconds)
    h = total // 3600
    m = (total % 3600) // 60
    s = total % 60
    if h > 0:
        return f"{h}h {m}m" if m > 0 else f"{h}h"
    if m > 0:
        return f"{m}m"
    return f"{s}s"


def session_seconds_left(expires_at) -> int | None:
    """Seconds left in the current session from an ISO expiresAt timestamp
    (computed locally for display only — enforcement stays server-side)."""
    if not expires_at:
        return None
    try:
        t = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00")).timestamp() * 1000
    except Exception:
        return None
    return max(0, round((t - datetime.now(timezone.utc).timestamp() * 1000) / 1000))


def session_status_line(state) -> str:
    """The \"Session X / 6 · time remaining · today's usage\" line shown after
    each run. Returns '' when there is no session state to display."""
    if not state or not isinstance(state.get("sessionsUsed"), (int, float)):
        return ""
    total = state["sessionsUsed"] + (state.get("sessionsRemaining") or 0)
    left = session_seconds_left(state.get("sessionExpiresAt"))
    remaining = format_countdown(left) if left is not None else "no active session"
    used_today = format_daily_usage(state.get("dailyUsedSeconds"))
    limit_today = format_daily_usage(state.get("dailyLimitSeconds"))
    return c.dim(f"Session {state.get('currentSession') or state['sessionsUsed']} / {total} · {remaining} left · {used_today} / {limit_today} used today")


def session_rollover_note(state) -> str:
    """Note shown when the server rolled the user into a fresh session."""
    if not state:
        return ""
    return c.dim(f"Session {state.get('currentSession')} of {state.get('sessionsUsed', 0) + (state.get('sessionsRemaining') or 0)} started — the previous session expired.")


def banner_free_plan_line(state) -> str:
    """Short banner row: \"Quota: 5 sessions remaining · 58m left\" or a simpler
    availability line when no session is active yet. '' when unavailable."""
    if not state or not isinstance(state.get("sessionsUsed"), (int, float)):
        return ""
    total = state["sessionsUsed"] + (state.get("sessionsRemaining") or 0)
    if state.get("currentSession") is not None and state.get("sessionExpiresAt"):
        left = format_countdown(session_seconds_left(state["sessionExpiresAt"]))
        return c.green(f"Quota · Session {state['currentSession']}/{total} · {left} left · {format_daily_usage(state.get('dailyUsedSeconds'))} used today")
    if (state.get("sessionsRemaining") or 0) == 0:
        return c.yellow(f"Quota · all {total} sessions used today — more at 00:00 UTC")
    return c.green(f"Quota · {state.get('sessionsRemaining')} sessions remaining today ({format_daily_usage(state.get('dailyLimitSeconds'))} max)")
