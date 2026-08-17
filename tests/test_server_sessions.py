"""Backend GRACE FREE session tests (port of the TS freeSessions + api tests).

Service-level tests use an injected clock for deterministic countdown math;
endpoint-level tests exercise GET /api/session/status, POST /api/session/end
and the /api/provider daily-limit gate through the WSGI app.
"""

from datetime import datetime, timedelta, timezone

from grace.server.free_sessions import FreeSessionService, seconds_until_utc_midnight, utc_day
from tests.helpers.wsgi_client import wsgi_call

NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
AUTH = {"Content-Type": "application/json"}


def _fixed(db):
    return FreeSessionService(db, {"now": lambda: NOW})


def _row(db, user_id, number, started, expires, ended=None):
    return {
        "id": f"s{number}",
        "user_id": user_id,
        "day": utc_day(started),
        "session_number": number,
        "started_at": started.isoformat(),
        "expires_at": expires.isoformat(),
        "ended_at": ended.isoformat() if ended else None,
    }


# ---------------------------------------------------------------------------
# Service level (deterministic clock)
# ---------------------------------------------------------------------------

def test_get_state_when_no_sessions(memory_db):
    svc = _fixed(memory_db["db"])
    state = svc.get_state("u1")
    assert state["sessionsUsed"] == 0
    assert state["sessionsRemaining"] == 3
    assert state["currentSession"] is None
    assert state["dailyUsedSeconds"] == 0
    assert state["dailyLimitSeconds"] == 3 * 3600


def test_ensure_active_starts_first_session(memory_db):
    svc = _fixed(memory_db["db"])
    gate = svc.ensure_active_session("u1")
    assert gate["ok"] is True
    assert gate["startedNew"] is True
    assert gate["state"]["sessionsUsed"] == 1
    assert gate["state"]["sessionsRemaining"] == 2
    assert gate["state"]["currentSession"] == 1
    assert gate["state"]["sessionStartedAt"] == NOW.isoformat()


def test_ensure_active_reuses_live_session(memory_db):
    db = memory_db["db"]
    db(
        "INSERT INTO free_sessions (user_id, day, session_number, started_at, expires_at) VALUES ($1, $2, $3, $4, $5)",
        ["u1", utc_day(NOW), 1, NOW.isoformat(), (NOW + timedelta(minutes=60)).isoformat()],
    )
    svc = _fixed(memory_db["db"])
    gate = svc.ensure_active_session("u1")
    assert gate["ok"] is True
    assert gate["startedNew"] is False
    assert gate["state"]["currentSession"] == 1
    assert len(memory_db["state"]["free_sessions"]) == 1


def test_auto_starts_next_session_after_expiry(memory_db):
    db = memory_db["db"]
    db(
        "INSERT INTO free_sessions (user_id, day, session_number, started_at, expires_at) VALUES ($1, $2, $3, $4, $5)",
        ["u1", utc_day(NOW), 1, (NOW - timedelta(hours=2)).isoformat(), (NOW - timedelta(hours=1)).isoformat()],
    )
    svc = _fixed(memory_db["db"])
    gate = svc.ensure_active_session("u1")
    assert gate["ok"] is True
    assert gate["startedNew"] is True
    assert gate["state"]["currentSession"] == 2
    assert gate["state"]["sessionsUsed"] == 2
    # The expired session was lazily marked ended.
    expired = memory_db["state"]["free_sessions"][0]
    assert expired["ended_at"] == expired["expires_at"]


def test_daily_limit_exhausted(memory_db):
    db = memory_db["db"]
    for n in (1, 2, 3):
        start = NOW - timedelta(hours=4 + n)
        db(
            "INSERT INTO free_sessions (user_id, day, session_number, started_at, expires_at) VALUES ($1, $2, $3, $4, $5)",
            ["u1", utc_day(NOW), n, start.isoformat(), (start + timedelta(minutes=60)).isoformat()],
        )
    svc = _fixed(memory_db["db"])
    gate = svc.ensure_active_session("u1")
    assert gate["ok"] is False
    assert gate["status"] == 429
    assert gate["code"] == "daily_limit_exhausted"
    assert "all 3 free sessions" in gate["error"]
    assert gate["state"]["sessionsRemaining"] == 0
    # The last expired session was lazily ended.
    assert memory_db["state"]["free_sessions"][-1]["ended_at"] is not None


def test_end_active_session_explicit(memory_db):
    db = memory_db["db"]
    db(
        "INSERT INTO free_sessions (user_id, day, session_number, started_at, expires_at) VALUES ($1, $2, $3, $4, $5)",
        ["u1", utc_day(NOW), 1, NOW.isoformat(), (NOW + timedelta(minutes=60)).isoformat()],
    )
    svc = _fixed(memory_db["db"])
    state = svc.end_active_session("u1")
    assert state["currentSession"] is None
    row = memory_db["state"]["free_sessions"][0]
    assert row["ended_at"] is not None
    assert row["ended_at"] != row["expires_at"]  # explicit end < expiry


def test_countdown_math(memory_db):
    db = memory_db["db"]
    started = NOW - timedelta(minutes=20)  # 20 minutes in
    db(
        "INSERT INTO free_sessions (user_id, day, session_number, started_at, expires_at) VALUES ($1, $2, $3, $4, $5)",
        ["u1", utc_day(NOW), 1, started.isoformat(), (started + timedelta(minutes=60)).isoformat()],
    )
    svc = _fixed(memory_db["db"])
    state = svc.get_state("u1")
    assert state["dailyUsedSeconds"] == 20 * 60
    assert state["sessionStartedAt"] == started.isoformat()
    assert state["sessionExpiresAt"] == (started + timedelta(minutes=60)).isoformat()


def test_seconds_until_utc_midnight():
    assert seconds_until_utc_midnight(datetime(2026, 6, 1, 23, 59, 30, tzinfo=timezone.utc)) == 30
    assert seconds_until_utc_midnight(datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)) == 12 * 3600


# ---------------------------------------------------------------------------
# Endpoint level
# ---------------------------------------------------------------------------

def _register(wsgi_app, email="u@example.com"):
    res = wsgi_call(wsgi_app, "POST", "/api/auth/register", headers=AUTH, body={"email": email, "password": "password123"})
    return res.json["token"]


def test_session_status_none(memory_db, wsgi_app):
    token = _register(wsgi_app)
    res = wsgi_call(wsgi_app, "GET", "/api/session/status", headers={"Authorization": f"Bearer {token}"})
    assert res.status == 200
    session = res.json["session"]
    assert session["status"] == "none"
    assert session["id"] is None
    assert session["started_at"] is None
    assert session["expires_at"] is None
    assert session["sessionsUsed"] == 0
    assert session["sessionsRemaining"] == 3
    assert session["provider"] == "none"
    assert session["model_router"] == []


def test_session_status_requires_auth(wsgi_app):
    assert wsgi_call(wsgi_app, "GET", "/api/session/status").status == 401


def test_end_session_without_active_session(memory_db, wsgi_app):
    token = _register(wsgi_app)
    res = wsgi_call(wsgi_app, "POST", "/api/session/end", headers={"Authorization": f"Bearer {token}"})
    assert res.status == 200
    assert res.json["session"]["status"] == "none"


def test_provider_gate_daily_limit(memory_db, wsgi_app, monkeypatch):
    """The authoritative free-plan gate: 3 sessions/day, then 429 with the
    daily_limit_exhausted code and the current session state."""
    from grace.providers.types import ChatResult, Usage

    monkeypatch.setenv("GROQ_API_KEY", "test-key")

    def fake_run_server_chat(req):
        return {
            "ok": True,
            "result": ChatResult(content="ok", toolCalls=[], usage=Usage(inputTokens=10, outputTokens=10, totalTokens=20)),
            "providerId": "groq",
            "providerLabel": "Groq (LPU)",
            "model": "openai/gpt-oss-20b",
        }

    import grace.server.handlers as handlers

    monkeypatch.setattr(handlers, "run_server_chat", fake_run_server_chat)

    token = _register(wsgi_app)
    body = {"messages": [{"role": "user", "content": "hi"}], "model": "openai/gpt-oss-20b"}

    for expected_session in (1, 2, 3):
        res = wsgi_call(wsgi_app, "POST", "/api/provider", headers={"Authorization": f"Bearer {token}", **AUTH}, body=body)
        assert res.status == 200, res.body
        assert res.json["provider_id"] == "groq"
        assert res.json["session"]["currentSession"] == expected_session
        # Expire the just-started session so the next call rolls into a new one
        # (sessions last 60 minutes; the real daily-limit test uses a clock).
        row = memory_db["state"]["free_sessions"][-1]
        row["expires_at"] = "2020-01-01T00:00:00Z"
        row["ended_at"] = "2020-01-01T00:00:00Z"

    res = wsgi_call(wsgi_app, "POST", "/api/provider", headers={"Authorization": f"Bearer {token}", **AUTH}, body=body)
    assert res.status == 429
    data = res.json
    assert data["code"] == "daily_limit_exhausted"
    assert data["session"]["sessionsRemaining"] == 0
    assert res.retry_after
    # The refused request released its cost reservation — nothing was spent.
    assert memory_db["state"]["daily_costs"][0]["reserved"] == 0


def test_provider_no_providers_without_keys(memory_db, wsgi_app):
    """With no provider keys configured the cost guard refuses BEFORE the
    session gate — a refused request consumes no session slot."""
    token = _register(wsgi_app)
    body = {"messages": [{"role": "user", "content": "hi"}]}
    res = wsgi_call(wsgi_app, "POST", "/api/provider", headers={"Authorization": f"Bearer {token}", **AUTH}, body=body)
    assert res.status == 503
    assert res.json["code"] == "no_providers"
    assert len(memory_db["state"]["free_sessions"]) == 0


def test_provider_requires_auth_and_valid_body(memory_db, wsgi_app, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    assert wsgi_call(wsgi_app, "POST", "/api/provider", headers=AUTH, body={"messages": [{"role": "user", "content": "x"}]}).status == 401
    token = _register(wsgi_app)
    res = wsgi_call(wsgi_app, "POST", "/api/provider", headers={"Authorization": f"Bearer {token}", **AUTH}, body={"messages": []})
    assert res.status == 400
    res = wsgi_call(wsgi_app, "POST", "/api/provider", headers={"Authorization": f"Bearer {token}", **AUTH}, body={"nope": True})
    assert res.status == 400
