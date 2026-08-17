"""Backend usage-recording tests (port of the TS api usage tests).

POST/GET /api/usage through the WSGI app against the in-memory database:
recording, idempotency via client_run_id, validation errors, and the rule
that a caller can never report usage as another user.
"""

from tests.helpers.wsgi_client import wsgi_call

AUTH = {"Content-Type": "application/json"}


def _register(wsgi_app, email="u@example.com"):
    res = wsgi_call(wsgi_app, "POST", "/api/auth/register", headers=AUTH, body={"email": email, "password": "password123"})
    return res.json["token"]


def _report(wsgi_app, token, **overrides):
    body = {
        "client_run_id": "run-1",
        "user_id": "someone-else",  # must be ignored — session is the source of truth
        "session_id": None,
        "project_type": "python",
        "prompt": "fix the tests",
        "status": "done",
        "model": "openai/gpt-oss-20b",
        "agent_turns": 3,
        "tool_calls": 2,
        "input_tokens": 1200,
        "output_tokens": 800,
        "execution_time_ms": 1234,
    }
    body.update(overrides)
    return wsgi_call(wsgi_app, "POST", "/api/usage", headers={"Authorization": f"Bearer {token}", **AUTH}, body=body)


def test_record_usage_requires_auth(wsgi_app):
    assert _report(wsgi_app, "bogus").status == 401
    assert wsgi_call(wsgi_app, "POST", "/api/usage", headers=AUTH, body={"model": "x"}).status == 401


def test_record_and_list_usage(memory_db, wsgi_app):
    token = _register(wsgi_app)
    res = _report(wsgi_app, token)
    assert res.status == 201
    assert res.json == {"recorded": True, "run_id": 1}

    # The user_id from the body was ignored.
    assert memory_db["state"]["runs"][0]["user_id"] == memory_db["state"]["users"][0]["id"]
    assert memory_db["state"]["usage_rows"][0]["input_tokens"] == 1200

    res = wsgi_call(wsgi_app, "GET", "/api/usage?limit=10", headers={"Authorization": f"Bearer {token}"})
    assert res.status == 200
    data = res.json
    assert len(data["usage"]) == 1
    assert data["usage"][0]["model"] == "openai/gpt-oss-20b"
    # The daily session summary rides along (GRACE FREE).
    assert data["sessionsUsed"] == 0
    assert data["sessionsRemaining"] == 3
    assert data["dailyLimitSeconds"] == 3 * 3600


def test_usage_is_scoped_per_user(memory_db, wsgi_app):
    token_a = _register(wsgi_app, email="a@example.com")
    token_b = _register(wsgi_app, email="b@example.com")
    _report(wsgi_app, token_a, client_run_id="run-a")
    _report(wsgi_app, token_b, client_run_id="run-b")

    data = wsgi_call(wsgi_app, "GET", "/api/usage", headers={"Authorization": f"Bearer {token_a}"}).json
    assert len(data["usage"]) == 1
    assert data["usage"][0]["run_id"] == memory_db["state"]["runs"][0]["id"]


def test_duplicate_client_run_id_is_idempotent(memory_db, wsgi_app):
    token = _register(wsgi_app)
    first = _report(wsgi_app, token)
    second = _report(wsgi_app, token)
    assert first.status == 201
    assert second.status == 201
    assert first.json["run_id"] == second.json["run_id"]
    assert len(memory_db["state"]["runs"]) == 1
    assert len(memory_db["state"]["usage_rows"]) == 1


def test_usage_validation_errors(memory_db, wsgi_app):
    token = _register(wsgi_app)
    assert _report(wsgi_app, token, model="").status == 400
    assert _report(wsgi_app, token, status="exploded").status == 400
    assert _report(wsgi_app, token, input_tokens=-1).status == 400
    assert _report(wsgi_app, token, input_tokens=1.5).status == 400
    assert _report(wsgi_app, token, agent_turns=-3).status == 400
    assert _report(wsgi_app, token, tool_calls="many").status == 400
    assert _report(wsgi_app, token, execution_time_ms=-5).status == 400
    # No rows were recorded by any of the failed attempts.
    assert len(memory_db["state"]["runs"]) == 0


def test_usage_requires_database(wsgi_app):
    from grace.server.db import set_db_for_tests

    set_db_for_tests(None)  # simulate a server without DATABASE_URL
    res = wsgi_call(wsgi_app, "POST", "/api/usage", headers=AUTH, body={"model": "x", "status": "done", "input_tokens": 0, "output_tokens": 0, "agent_turns": 0})
    assert res.status == 503
