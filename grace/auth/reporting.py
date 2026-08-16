"""Usage reporting (port of src/auth/reporting.ts).

After each agent run the CLI reports usage to the backend when a valid session
exists. Reporting is deliberately fire-and-forget safe:
  - never throws (the agent keeps working no matter what),
  - short timeout so it cannot hang the terminal,
  - skips silently when the user is not logged in (pure offline mode),
  - clears the local session when the backend says the token is invalid.
"""

import uuid

from grace.auth.client import ApiClient, ApiError
from grace.auth.session import clear_session, load_session, session_expired

# Keep in sync with the wire contract (src/api/usage.ts UsageReport).
STATUS_DONE = "done"


def build_usage_report(input_info: dict) -> dict | None:
    """Build the /api/usage payload from an agent run. None when there is no usage to report."""
    usage = input_info.get("usage")
    if not usage:
        return None
    return {
        "client_run_id": str(uuid.uuid4()),
        "user_id": "",  # replaced by send_usage_report with the session user's id
        "session_id": input_info.get("sessionId"),
        "project_type": input_info.get("projectType") or None,
        "prompt": input_info.get("prompt"),
        "status": STATUS_DONE,
        "model": input_info.get("model"),
        "agent_turns": input_info.get("iterations", 0),
        "tool_calls": input_info.get("toolCalls"),
        "input_tokens": usage.get("inputTokens", 0),
        "output_tokens": usage.get("outputTokens", 0),
        # The backend validates this as an integer (TS sends Date.now() diffs);
        # monotonic()*1000 is a float, so cast before sending.
        "execution_time_ms": int(input_info.get("executionTimeMs") or 0),
    }


def send_usage_report(session: dict, report: dict, clear=clear_session) -> str:
    """Send a report for an already-loaded session. Never throws.
    `clear` is the local-session removal hook (injectable for tests)."""
    try:
        payload = {**report, "user_id": session["user"]["id"]}
        # Short timeout: reporting is best-effort and must never stall the CLI.
        ApiClient(session["apiUrl"], 3000).report_usage(session["token"], payload)
        return "reported"
    except ApiError as err:
        if err.status == 401:
            clear()
        return "failed"
    except Exception:
        return "failed"


def report_run_usage(input_info: dict, session_override=None, clear=clear_session) -> str:
    """Report one agent run when authenticated. Returns the outcome; callers may
    await it (bounded by the client timeout) or fire-and-forget."""
    session = load_session() if session_override is None else session_override
    if not session:
        return "skipped"
    if session_expired(session):
        clear()
        return "skipped"
    report = build_usage_report(input_info)
    if not report:
        return "skipped"
    return send_usage_report(session, report, clear)
