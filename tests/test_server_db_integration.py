"""Optional integration tests against a REAL PostgreSQL / Neon database.

The fake test DB (`tests/helpers/memory_db.py`) matches SQL by substring and
reads params positionally, so it cannot validate SQL semantics — it passed
both the `$1` placeholder bug and the placeholder-ORDER bug that 500'd the
deployed backend (`operator does not exist: uuid = smallint` in
cost_guard.settle). These tests run the real psycopg path against a real
database, which is the only way to catch that class of bug.

Enable by setting `TEST_DATABASE_URL` (e.g. the same Neon connection string
used in production). The test creates a throwaway account, runs the full
/api/provider flow (register → auth → cost guard → free session → real
provider call → settle → session end) and deletes the account afterwards.
Skipped when the variable is unset, so `python -m pytest` stays green
without a database.

The provider call is a REAL LLM request (uses the provider keys from the
project .env), so this test also needs those keys present.
"""

import os
import uuid
from pathlib import Path

import pytest

TEST_DATABASE_URL = (os.environ.get("TEST_DATABASE_URL") or "").strip()

pytestmark = pytest.mark.skipif(
    not TEST_DATABASE_URL,
    reason="TEST_DATABASE_URL not set (point it at a real Postgres/Neon to run)",
)

PROVIDER_ENV_NAMES = (
    "GROQ_API_KEY",
    "NVIDIA_API_KEY",
    "GEMINI_API_KEY",
    "MINIMAX_API_KEY",
    "DEEPSEEK_API_KEY",
)


def _set_provider_keys_from_dotenv(monkeypatch):
    """Load the provider keys from the project .env into the test env
    (monkeypatch-scoped) so the real provider chain is configured."""
    path = Path(__file__).resolve().parent.parent / ".env"
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key in PROVIDER_ENV_NAMES and key not in os.environ:
            monkeypatch.setenv(key, value)


@pytest.fixture
def neon_db():
    from grace.server.db import create_psycopg_db, set_db_for_tests

    db = create_psycopg_db(TEST_DATABASE_URL)
    set_db_for_tests(db)
    yield db
    set_db_for_tests(None)


def test_provider_flow_end_to_end_on_real_db(neon_db, monkeypatch):
    """The exact /api/provider flow against a real database: register → auth →
    cost guard → free session → real provider call → settle → session end.
    Regressions: cost_guard.settle / _release_* and free_sessions
    end_active_session must bind params in SQL-text order (psycopg is
    positional — a mismatch raises 42883 'uuid = smallint')."""
    _set_provider_keys_from_dotenv(monkeypatch)

    from grace.server.auth_service import AuthService
    from grace.server.cost_guard import CostGuardService
    from grace.server.free_sessions import FreeSessionService
    from grace.server.providers import run_server_chat

    db = neon_db
    email = f"integration-{uuid.uuid4().hex[:8]}@example.com"
    password = "TestPass123!"
    try:
        reg = AuthService(db).register({"email": email, "password": password}, "cli", {"beta": True})
        user_id = reg["user"]["id"]

        svc = FreeSessionService(db)
        cost_guard = CostGuardService(db)
        chat_request = {
            "messages": [{"role": "user", "content": "Reply with exactly: INTEGRATION-OK"}],
            "model": "openai/gpt-oss-20b",
            "temperature": 0.2,
        }

        last_row = svc.last_session_row(user_id)
        cost_gate = cost_guard.guard_chat(user_id, chat_request, last_row["id"] if last_row else None)
        assert cost_gate["ok"], cost_gate
        gate = svc.ensure_active_session(user_id)
        assert gate["ok"] and gate["startedNew"] is True
        if cost_gate.get("maxTokens") is not None:
            chat_request["maxTokens"] = cost_gate["maxTokens"]

        outcome = run_server_chat(chat_request)
        assert outcome["ok"], outcome
        result = outcome["result"]
        assert result.content
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

        # Exercises the fixed end_active_session UPDATE (ended_at = %s, id = %s).
        ended = svc.end_active_session(user_id)
        assert ended["currentSession"] is None  # session ended → no longer active

        # Release path (request-failure settlement) must also bind correctly.
        gate2 = svc.ensure_active_session(user_id)  # starts session 2
        assert gate2["ok"]
        cost_guard.settle(cost_gate["reservation"], None)
    finally:
        # Remove the throwaway account (cascades to its rows everywhere).
        db("DELETE FROM users WHERE email = %s", [email])
