"""Route handlers for the GRACE API (port of src/api/handlers.ts).

Handlers use the tiny (req, res) abstraction from grace/server/types.py so
they can be exported directly from `api/*.py` WSGI functions, and the local
dev server (grace/server/serve.py) adapts WSGI to the same shape — mirroring
the TS design where api/*.ts and the local node:http server shared the same
handlers.

Auth model: shared-token auth was replaced by real user sessions
(POST /api/auth/register|login|logout, GET /api/auth/me). Protected endpoints
resolve the session via `require_session` and scope data to the authenticated
user — a caller can never impersonate another user_id.
"""

import os
from datetime import datetime, timezone

from grace.meta import VERSION
from grace.server import auth as auth_guard
from grace.server.auth_service import AuthError, AuthService, normalize_email
from grace.server.beta import beta_access_for
from grace.server.cost_guard import CostGuardService
from grace.server.db import DbError, get_db
from grace.server.free_sessions import FreeSessionService, seconds_until_utc_midnight
from grace.server.log import log_api_event
from grace.server.providers import describe_server_router, run_server_chat
from grace.server.rate_limit import check_rate_limit, client_ip
from grace.server.types import is_object, method_not_allowed
from grace.server.usage import UsageError, UsageService

DB_NOT_CONFIGURED = (
    "DATABASE_URL is not configured on the server. Add it to the server environment "
    "(Vercel: Project → Settings → Environment Variables, or .env for the local dev "
    "server) and redeploy."
)


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

def health_handler(req: dict, res) -> None:
    """GET /api/health — liveness + config probe (public)."""
    if req.get("method") != "GET":
        return method_not_allowed(res, "GET")

    database = "not_configured"
    db = get_db()
    if db:
        try:
            db("SELECT 1")
            database = "connected"
        except Exception:
            database = "error"

    res.status(200).json(
        {
            "status": "ok",
            "service": "zeesh-api",
            "version": VERSION,
            "time": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "database": database,
            "auth": "configured" if _db_configured() else "not_configured",
        }
    )


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------

def register_handler(req: dict, res) -> None:
    """POST /api/auth/register — create an account and return a session token."""
    if req.get("method") != "POST":
        return method_not_allowed(res, "POST")
    db = get_db()
    if not db:
        return res.status(503).json({"error": DB_NOT_CONFIGURED})
    rate = check_rate_limit("auth", f"{client_ip(req.get('headers', {}))}:register")
    if not rate["ok"]:
        return too_many_requests(res, rate["retryAfterSeconds"])
    if not is_object(req.get("body")):
        return res.status(400).json({"error": "Request body must be a JSON object."})

    email = string_field(req.get("body", {}).get("email"))
    password = string_field(req.get("body", {}).get("password"))
    display_name = req.get("body", {}).get("display_name")
    display_name = display_name if isinstance(display_name, str) else None

    # Closed beta gate (email allowlist via ZEESH_BETA_* env). Only applied to
    # otherwise-valid attempts, so validation failures (400) still win over the
    # gate (403) for malformed input.
    normalized_email = normalize_email(email)
    access = beta_access_for(normalized_email or email)
    if normalized_email and len(password) >= 8 and not access["allowed"]:
        return res.status(403).json(
            {"error": "GRACE is in a closed beta. Registration is currently by invitation only."}
        )

    try:
        result = AuthService(db).register({"email": email, "password": password, "displayName": display_name}, "cli", {"beta": access["isBeta"]})
        res.status(201).json({"user": to_api_user(result["user"]), "token": result["token"], "expires_at": result["expiresAt"]})
    except AuthError as err:
        return res.status(err.status).json({"error": err.message})
    except DbError:
        # Let the middleware map schema (42P01/42703) and privilege (42501)
        # failures to an actionable 503 — a silent 500 hides unapplied
        # migrations or a misconfigured DATABASE_URL.
        raise
    except Exception:
        res.status(500).json({"error": "Could not create the account."})


def login_handler(req: dict, res) -> None:
    """POST /api/auth/login — verify credentials and return a session token."""
    if req.get("method") != "POST":
        return method_not_allowed(res, "POST")
    db = get_db()
    if not db:
        return res.status(503).json({"error": DB_NOT_CONFIGURED})
    rate = check_rate_limit("auth", f"{client_ip(req.get('headers', {}))}:login")
    if not rate["ok"]:
        return too_many_requests(res, rate["retryAfterSeconds"])
    if not is_object(req.get("body")):
        return res.status(400).json({"error": "Request body must be a JSON object."})

    email = string_field(req.get("body", {}).get("email"))
    password = string_field(req.get("body", {}).get("password"))
    try:
        result = AuthService(db).login({"email": email, "password": password}, "cli")
        res.status(200).json({"user": to_api_user(result["user"]), "token": result["token"], "expires_at": result["expiresAt"]})
    except AuthError as err:
        return res.status(err.status).json({"error": err.message})
    except DbError:
        # Same as register: surface DB schema/privilege failures as 503, not a
        # silent 500 that reads as a mystery backend crash.
        raise
    except Exception:
        res.status(500).json({"error": "Could not log in."})


def logout_handler(req: dict, res) -> None:
    """POST /api/auth/logout — invalidate the presented session."""
    if req.get("method") != "POST":
        return method_not_allowed(res, "POST")
    db = get_db()
    if not db:
        return res.status(503).json({"error": DB_NOT_CONFIGURED})
    auth_result = auth_guard.require_session(req, db)
    if not auth_result["ok"]:
        return res.status(auth_result["status"]).json({"error": auth_result["error"]})

    AuthService(db).logout(auth_guard.bearer_token(req))
    res.status(200).json({"logged_out": True})


def me_handler(req: dict, res) -> None:
    """GET /api/auth/me — current user from the session (used by `whoami`)."""
    if req.get("method") != "GET":
        return method_not_allowed(res, "GET")
    db = get_db()
    if not db:
        return res.status(503).json({"error": DB_NOT_CONFIGURED})
    auth_result = auth_guard.require_session(req, db)
    if not auth_result["ok"]:
        return res.status(auth_result["status"]).json({"error": auth_result["error"]})

    res.status(200).json({"user": to_api_user(auth_result["user"])})


# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

def usage_handler(req: dict, res) -> None:
    """POST/GET /api/usage — usage recording + per-user recent usage (session auth)."""
    if req.get("method") == "POST":
        return record_usage(req, res)
    if req.get("method") == "GET":
        return list_usage(req, res)
    return method_not_allowed(res, "POST, GET")


def record_usage(req: dict, res) -> None:
    db = get_db()
    if not db:
        return res.status(503).json({"error": DB_NOT_CONFIGURED})
    auth_result = auth_guard.require_session(req, db)
    if not auth_result["ok"]:
        return res.status(auth_result["status"]).json({"error": auth_result["error"]})
    rate = check_rate_limit("api", f"{client_ip(req.get('headers', {}))}:usage")
    if not rate["ok"]:
        return too_many_requests(res, rate["retryAfterSeconds"])
    if not is_object(req.get("body")):
        return res.status(400).json({"error": "Request body must be a JSON object."})

    try:
        # The user_id in the body is ignored — the session is the source of
        # truth, so a caller can never report usage as someone else.
        report = dict(req["body"])
        report["user_id"] = auth_result["user"]["id"]
        run_id = UsageService(db).record_usage(report)["runId"]
        # Observability: model/token/run facts, scrubbed — never the prompt.
        log_api_event(
            {
                "method": "POST",
                "path": "/api/usage",
                "status": 201,
                "latencyMs": 0,
                "userId": auth_result["user"]["id"],
                "model": report.get("model"),
                "tokens": {"input": report.get("input_tokens"), "output": report.get("output_tokens")},
                "runId": run_id,
            }
        )
        res.status(201).json({"recorded": True, "run_id": run_id})
    except UsageError as err:
        return res.status(err.status).json({"error": err.message})
    except DbError:
        raise
    except Exception:
        res.status(500).json({"error": "Could not record usage."})


def list_usage(req: dict, res) -> None:
    db = get_db()
    if not db:
        return res.status(503).json({"error": DB_NOT_CONFIGURED})
    auth_result = auth_guard.require_session(req, db)
    if not auth_result["ok"]:
        return res.status(auth_result["status"]).json({"error": auth_result["error"]})

    raw = req.get("query", {}).get("limit")
    try:
        raw_num = int(raw)
        limit = min(raw_num, 100) if raw_num > 0 else 20
    except (TypeError, ValueError):
        limit = 20
    try:
        rows = UsageService(db).recent_usage_for_user(auth_result["user"]["id"], limit)
        # The daily session summary rides along so the CLI can render
        # "Session X / 6 · time remaining · today's usage" without trusting any
        # client-side state. get_state is read-only — it never starts or
        # consumes a session.
        session_state = FreeSessionService(db).get_state(auth_result["user"]["id"])
        res.status(200).json({"usage": rows, **session_state})
    except DbError:
        raise
    except Exception:
        res.status(500).json({"error": "Could not load usage."})


# ---------------------------------------------------------------------------
# Session status / end (server-authoritative free sessions)
# ---------------------------------------------------------------------------

def session_status_handler(req: dict, res) -> None:
    """GET /api/session/status — the server-authoritative session state:
    status, timestamps, daily quota, and the router's provider/model info.
    Read-only: it never starts or ends a session (unlike /api/provider)."""
    if req.get("method") != "GET":
        return method_not_allowed(res, "GET")
    db = get_db()
    if not db:
        return res.status(503).json({"error": DB_NOT_CONFIGURED})
    auth_result = auth_guard.require_session(req, db)
    if not auth_result["ok"]:
        return res.status(auth_result["status"]).json({"error": auth_result["error"]})

    svc = FreeSessionService(db)
    state = svc.get_state(auth_result["user"]["id"])
    last = svc.last_session_row(auth_result["user"]["id"])
    router = describe_server_router()
    res.status(200).json(
        {
            "session": {
                **state,
                "id": last["id"] if last else None,
                "status": session_status_label(last, state),
                "started_at": last["started_at"] if last else None,
                "expires_at": last["expires_at"] if last else None,
                "provider": router["primary"],
                "model": router["model"],
                "model_router": router["providers"],
            }
        }
    )


def end_session_handler(req: dict, res) -> None:
    """POST /api/session/end — explicitly end the active session. The server is
    the only writer: the CLI can only request an end, never fabricate one.
    Ending never starts a replacement session."""
    if req.get("method") != "POST":
        return method_not_allowed(res, "POST")
    db = get_db()
    if not db:
        return res.status(503).json({"error": DB_NOT_CONFIGURED})
    auth_result = auth_guard.require_session(req, db)
    if not auth_result["ok"]:
        return res.status(auth_result["status"]).json({"error": auth_result["error"]})

    svc = FreeSessionService(db)
    state = svc.end_active_session(auth_result["user"]["id"])
    last = svc.last_session_row(auth_result["user"]["id"])
    res.status(200).json(
        {
            "session": {
                **state,
                "id": last["id"] if last else None,
                "status": session_status_label(last, state),
                "started_at": last["started_at"] if last else None,
                "expires_at": last["expires_at"] if last else None,
            }
        }
    )


def session_status_label(last: dict | None, state: dict) -> str:
    """Session state label for read-only status:
      - 'active'    a session is live right now,
      - 'ended'     the last session was explicitly ended early
                    (ended_at < expires_at) — never reused,
      - 'expired'   the last session ran out naturally (or was lazy-ended at
                    its expiry),
      - 'none'      no session today.
    """
    if last is not None and state.get("currentSession") is not None:
        return "active"
    if last is not None and last.get("ended_at") is not None:
        ended = _iso_ms(last["ended_at"])
        expires = _iso_ms(last["expires_at"])
        # Explicit end marks ended_at = now (< expires_at); natural expiry
        # lazy-ends with ended_at = expires_at.
        if ended is not None and expires is not None and ended < expires:
            return "ended"
    if (state.get("sessionsUsed") or 0) > 0:
        return "expired"
    return "none"


# ---------------------------------------------------------------------------
# Provider proxy
# ---------------------------------------------------------------------------

def provider_handler(req: dict, res) -> None:
    """POST /api/provider — proxy a chat completion (session auth)."""
    if req.get("method") != "POST":
        return method_not_allowed(res, "POST")
    db = get_db()
    if not db:
        return res.status(503).json({"error": DB_NOT_CONFIGURED})
    auth_result = auth_guard.require_session(req, db)
    if not auth_result["ok"]:
        return res.status(auth_result["status"]).json({"error": auth_result["error"]})
    rate = check_rate_limit("api", f"{client_ip(req.get('headers', {}))}:provider")
    if not rate["ok"]:
        return too_many_requests(res, rate["retryAfterSeconds"])
    if not is_object(req.get("body")):
        return res.status(400).json({"error": "Request body must be a JSON object."})

    # Validate the payload BEFORE the free-plan gate so a malformed request can
    # never consume (or start) a session slot.
    chat_request = req["body"]
    messages = chat_request.get("messages")
    if not isinstance(messages, list) or len(messages) == 0:
        return res.status(400).json({"error": '"messages" must be a non-empty array.'})

    # Internal cost guard: the per-user daily cost ceiling (₹20/day) and the
    # global circuit breaker are enforced BEFORE any provider call AND before
    # the session gate, so a refused request never consumes a session slot. The
    # guard reserves worst-case budget, bounds max output tokens to what the
    # remaining budget allows, and settles afterwards.
    svc = FreeSessionService(db)
    cost_guard = CostGuardService(db)
    last_row = svc.last_session_row(auth_result["user"]["id"])
    session_id = last_row["id"] if last_row else None
    cost_gate = cost_guard.guard_chat(auth_result["user"]["id"], chat_request, session_id)
    if not cost_gate["ok"]:
        if cost_gate.get("retryAfterSeconds") is not None:
            res.set_header("Retry-After", str(cost_gate["retryAfterSeconds"]))
        return res.status(cost_gate["status"]).json(
            {
                "error": cost_gate["error"],
                "code": cost_gate["code"],
                # Read-only session state rides along so the CLI still renders the quota.
                "session": svc.get_state(auth_result["user"]["id"]),
            }
        )

    # The free-plan gate is authoritative and runs BEFORE any provider call, so
    # exhausted/expired accounts never reach the model. An expired session with
    # quota left auto-starts the next one; the response tells the CLI a new
    # session began (session.startedNew).
    gate = svc.ensure_active_session(auth_result["user"]["id"])
    if not gate["ok"]:
        # "All N sessions used" — release the reserved budget (no inference
        # happened) and hint Retry-After at the next UTC day.
        cost_guard.settle(cost_gate["reservation"], None)
        res.set_header("Retry-After", str(seconds_until_utc_midnight()))
        return res.status(gate["status"]).json({"error": gate["error"], "code": gate["code"], "session": gate["state"]})

    # Bound max output tokens to the reserved budget before sending.
    if cost_gate.get("maxTokens") is not None:
        chat_request["maxTokens"] = cost_gate["maxTokens"]

    outcome = run_server_chat(chat_request)
    if not outcome["ok"]:
        # The request never reached the model (or failed) — release the
        # reservation in full; nothing was spent.
        cost_guard.settle(cost_gate["reservation"], None)
        return res.status(outcome["status"]).json({"error": outcome["error"]})

    # Settle the ACTUAL cost and release the unused reservation, and record the
    # ai_usage row for internal economics.
    result = outcome["result"]
    usage = getattr(result, "usage", None)
    cost_guard.settle(
        cost_gate["reservation"],
        {
            "provider": outcome["providerId"],
            "model": outcome["model"],
            "inputTokens": getattr(usage, "inputTokens", 0) if usage else 0,
            "cachedInputTokens": getattr(usage, "cachedInputTokens", 0) if usage else 0,
            "outputTokens": getattr(usage, "outputTokens", 0) if usage else 0,
        },
    )

    res.status(200).json(
        {
            "content": getattr(result, "content", None),
            "tool_calls": [_tool_call_payload(tc) for tc in getattr(result, "toolCalls", [])],
            "usage": _usage_payload(usage),
            "finish_reason": getattr(result, "finishReason", "stop"),
            # Which provider actually served the request (after router
            # fallback), so the CLI can show e.g. "Provider: NVIDIA NIM"
            # without any key.
            "provider_id": outcome["providerId"],
            "provider_label": outcome["providerLabel"],
            # The current free-plan state (and whether this request rolled the
            # user into a fresh session) so the CLI can render the quota line.
            "session": {**gate["state"], "startedNew": gate["startedNew"]},
        }
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def too_many_requests(res, retry_after_seconds: int) -> None:
    res.set_header("Retry-After", str(retry_after_seconds)).status(429).json(
        {"error": f"Too many requests. Try again in {retry_after_seconds}s."}
    )


def string_field(v) -> str:
    """Coerce an unknown body field to a string (validation happens in AuthService)."""
    return v if isinstance(v, str) else ""


def to_api_user(user: dict) -> dict:
    """Serialize an AuthUser to the API's snake_case shape."""
    return {"id": user["id"], "email": user["email"], "display_name": user.get("displayName")}


def _db_configured() -> bool:
    return bool((os.environ.get("DATABASE_URL") or "").strip())


def _iso_ms(value: str) -> int | None:
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, TypeError):
        return None


def _tool_call_payload(tc) -> dict:
    if isinstance(tc, dict):
        return {"id": tc.get("id"), "name": tc.get("name"), "arguments": tc.get("arguments")}
    return {"id": getattr(tc, "id", ""), "name": getattr(tc, "name", ""), "arguments": getattr(tc, "arguments", "")}


def _usage_payload(usage) -> dict | None:
    if usage is None:
        return None
    if isinstance(usage, dict):
        return {
            "inputTokens": usage.get("inputTokens", 0),
            "outputTokens": usage.get("outputTokens", 0),
            "totalTokens": usage.get("totalTokens", 0),
            "cachedInputTokens": usage.get("cachedInputTokens", 0),
        }
    return {
        "inputTokens": getattr(usage, "inputTokens", 0),
        "outputTokens": getattr(usage, "outputTokens", 0),
        "totalTokens": getattr(usage, "totalTokens", 0),
        "cachedInputTokens": getattr(usage, "cachedInputTokens", 0),
    }
