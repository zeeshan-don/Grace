"""End-to-end: the real Python CLI against the real Python backend.

Boots the shared WSGI app in a threaded wsgiref server on an ephemeral port
and drives it with the exact HTTP client the CLI uses (`grace.auth.client.ApiClient`
and `grace.providers.remote.RemoteProvider`) — no mocks on the wire contract.
"""

import pytest
import requests

from grace.auth.client import ApiClient, ApiError
from grace.auth.session import save_session, clear_session
from grace.providers.remote import RemoteProvider
from grace.providers.types import ChatResult, Usage


@pytest.fixture(autouse=True)
def clean_local_session(tmp_path, monkeypatch):
    """Point the CLI's session persistence at a temp path so tests never touch
    the developer's real ~/.zeesh/auth.json."""
    import grace.auth.session as session_mod

    path = str(tmp_path / "auth.json")
    monkeypatch.setattr(session_mod, "DEFAULT_PATH", path)
    monkeypatch.setattr("grace.auth.client.DEFAULT_TIMEOUT_MS", 5000)
    yield path
    clear_session(path)


def test_health(clean_local_session, live_server):
    res = requests.get(f"{live_server}/api/health", timeout=5)
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["database"] == "connected"


def test_full_auth_and_usage_flow(clean_local_session, live_server):
    api = ApiClient(live_server)

    reg = api.register("e2e@example.com", "password123", display_name="E2E Tester")
    assert reg["user"]["email"] == "e2e@example.com"
    assert reg["user"]["display_name"] == "E2E Tester"
    assert len(reg["token"]) == 64

    # The CLI persists the session exactly like `grace login` does.
    save_session(
        {
            "apiUrl": live_server,
            "token": reg["token"],
            "user": {"id": reg["user"]["id"], "email": reg["user"]["email"], "displayName": reg["user"]["display_name"]},
            "expiresAt": reg["expires_at"],
            "createdAt": reg["expires_at"],
        },
        clean_local_session,
    )

    me = api.me(reg["token"])
    assert me["email"] == "e2e@example.com"

    reported = api.report_usage(
        reg["token"],
        {
            "client_run_id": "e2e-run-1",
            "user_id": "",  # backend must derive this from the session
            "session_id": None,
            "project_type": "python",
            "prompt": "e2e prompt",
            "status": "done",
            "model": "openai/gpt-oss-20b",
            "agent_turns": 2,
            "tool_calls": 1,
            "input_tokens": 100,
            "output_tokens": 50,
            "execution_time_ms": 200,
        },
    )
    assert reported == {"recorded": True, "run_id": 1}

    usage = api.get_usage(reg["token"])
    assert len(usage["usage"]) == 1
    assert usage["usage"][0]["model"] == "openai/gpt-oss-20b"
    assert usage["sessionsRemaining"] == 3

    status = api.get_session_status(reg["token"])
    assert status["session"]["status"] == "none"
    assert status["session"]["provider"] == "none"

    ended = api.end_session(reg["token"])
    assert ended["session"]["status"] == "none"

    api.logout(reg["token"])
    with pytest.raises(ApiError) as exc:
        api.me(reg["token"])
    assert exc.value.status == 401


def test_login_wrong_password(clean_local_session, live_server):
    api = ApiClient(live_server)
    api.register("login@example.com", "password123")
    with pytest.raises(ApiError) as exc:
        api.login("login@example.com", "wrong-password")
    assert exc.value.status == 401


def test_remote_provider_proxy(clean_local_session, live_server, monkeypatch):
    """The CLI's RemoteProvider drives POST /api/provider end-to-end; the
    provider call itself is stubbed server-side (no real keys needed)."""
    import grace.server.handlers as handlers

    monkeypatch.setenv("GROQ_API_KEY", "test-key")

    def fake_run_server_chat(req):
        return {
            "ok": True,
            "result": ChatResult(content="hello from the server", toolCalls=[], usage=Usage(inputTokens=7, outputTokens=3, totalTokens=10)),
            "providerId": "groq",
            "providerLabel": "Groq (LPU)",
            "model": "openai/gpt-oss-20b",
        }

    monkeypatch.setattr(handlers, "run_server_chat", fake_run_server_chat)

    api = ApiClient(live_server)
    reg = api.register("proxy@example.com", "password123")

    provider = RemoteProvider(api_url=live_server, token=reg["token"], model="openai/gpt-oss-20b")
    result = provider.chat([{"role": "user", "content": "hi"}])
    assert result.content == "hello from the server"
    assert result.usage.inputTokens == 7
    assert provider.server_provider["id"] == "groq"
    # The session state the server sent back is visible to the CLI.
    assert provider.last_session["currentSession"] == 1
    assert provider.last_session["sessionsRemaining"] == 2


def test_remote_provider_reports_quota_errors(clean_local_session, live_server, memory_db, monkeypatch):
    """The CLI surfaces the server's 429 daily_limit_exhausted message."""
    import grace.server.handlers as handlers

    monkeypatch.setenv("GROQ_API_KEY", "test-key")

    def fake_run_server_chat(req):
        return {
            "ok": True,
            "result": ChatResult(content="ok", toolCalls=[], usage=Usage(inputTokens=1, outputTokens=1, totalTokens=2)),
            "providerId": "groq",
            "providerLabel": "Groq (LPU)",
            "model": "openai/gpt-oss-20b",
        }

    monkeypatch.setattr(handlers, "run_server_chat", fake_run_server_chat)

    api = ApiClient(live_server)
    reg = api.register("quota@example.com", "password123")
    provider = RemoteProvider(api_url=live_server, token=reg["token"], model="openai/gpt-oss-20b")

    for _ in range(3):
        provider.chat([{"role": "user", "content": "hi"}])
        # Expire the just-started session so the next call rolls into a new one
        # (the server thread shares this in-memory db).
        row = memory_db["state"]["free_sessions"][-1]
        row["expires_at"] = "2020-01-01T00:00:00Z"
        row["ended_at"] = "2020-01-01T00:00:00Z"

    with pytest.raises(Exception) as exc:
        provider.chat([{"role": "user", "content": "hi"}])
    assert "all 3 free sessions" in str(exc.value)
