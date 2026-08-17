"""TUI runtime facts (port of src/cli/tui/info.ts).

Every value in the header/home screen comes from real state: the workspace
the CLI was launched in, the configured provider/model, the auth session and
(best-effort) the server's free-plan quota. Nothing is invented.
"""

import os

from grace.auth.client import ApiClient
from grace.auth.session import load_session, session_expired
from grace.cli.free_plan import (
    banner_free_plan_line,
    format_countdown,
    session_seconds_left,
)
from grace.cli.ui.theme import strip_ansi
from grace.meta import VERSION
from grace.providers.remote import RemoteProvider
from grace.util_text import short_path


def build_tui_info(runtime, free_plan_line: str | None = None) -> dict:
    """Synchronous snapshot of real runtime facts."""
    stored = load_session()
    logged_in = stored is not None and not session_expired(stored)
    session_label = stored["user"]["email"] if logged_in and stored else "Local mode"

    served = runtime.provider.server_provider if hasattr(runtime.provider, "server_provider") and isinstance(runtime.provider, RemoteProvider) else None
    provider_label = (served or {}).get("label") or (runtime.provider.label if runtime.provider else "")
    model = runtime.provider.get_model().id if runtime.provider else ""

    return {
        "version": VERSION,
        "workspace": short_path(runtime.root, os.path.expanduser("~")),
        "provider": provider_label,
        "providerAvailable": runtime.provider is not None,
        "providerError": runtime.provider_error or None,
        "model": model,
        "session": session_label,
        "freePlan": free_plan_line,
    }


def refresh_free_plan() -> str | None:
    """Best-effort free-plan + session-time fetch from the backend (real data).
    Never delays or breaks the UI: failures just leave the line unset."""
    stored = load_session()
    if not stored or session_expired(stored):
        return None
    try:
        state = ApiClient(stored["apiUrl"], 2000).get_usage(stored["token"])
        # Seed the shared session view so the live countdown renders even
        # before the first task (display only — the server enforces).
        RemoteProvider.set_shared_session(state)
        return strip_ansi(banner_free_plan_line(state))
    except Exception:
        return None


def session_status_line_for(runtime) -> str:
    stored = load_session()
    if not stored or session_expired(stored):
        return "Local mode"
    return stored["user"]["email"]


def session_countdown() -> str | None:
    stored = load_session()
    if not stored or session_expired(stored):
        return None
    state = RemoteProvider.shared_session()
    if not state or not state.get("sessionExpiresAt"):
        return None
    return format_countdown(session_seconds_left(state["sessionExpiresAt"]))
