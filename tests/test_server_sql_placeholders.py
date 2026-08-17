"""Regression tests for the server SQL placeholder bug.

The deployed backend returned `500 Internal server error.` on every
database-touching endpoint (register, login, and every authenticated call
including /api/provider). Root cause: the SQL was ported from the TypeScript
backend and kept node-postgres `$1` placeholders, but the Python backend runs
queries through psycopg, which only understands `%s`. psycopg treats `$1` as
literal SQL text, so every parameterized query failed with
`ProgrammingError: the query has 0 placeholders but 1 parameters were passed`
→ wrapped as DbError("XXXXX", …) → generic 500. (health worked because
`SELECT 1` has no parameters.)

These tests guard the failure class:
  1. no `$N` placeholder may appear in the service SQL files, and
  2. every query the services actually execute must have exactly one `%s`
     per parameter — psycopg has no node-postgres style placeholder reuse
     (e.g. `$6` referenced twice), so a query can silently pass the fake
     test DB while breaking production psycopg.
"""

import pathlib
import re

SERVICE_FILES = [
    "grace/server/auth_service.py",
    "grace/server/usage.py",
    "grace/server/free_sessions.py",
    "grace/server/cost_guard.py",
]

_DOLLAR_PLACEHOLDER = re.compile(r"\$\d")


def _service_files():
    root = pathlib.Path(__file__).resolve().parent.parent
    return [(rel, root / rel) for rel in SERVICE_FILES]


def test_no_node_postgres_placeholders_in_service_sql():
    """psycopg (the production DB driver) only understands %s. Any $N in the
    SQL the server executes is a node-postgres leftover that 500s in
    production — the fake test DB does not catch it."""
    bad = []
    for rel, path in _service_files():
        for i, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            line = raw.split("#", 1)[0]  # ignore # comments
            if _DOLLAR_PLACEHOLDER.search(line):
                bad.append(f"{rel}:{i}: {raw.strip()}")
    assert not bad, (
        "node-postgres $N placeholders are invalid for psycopg — use %s: "
        + "; ".join(bad)
    )


def test_every_executed_query_has_one_placeholder_per_param(memory_db, monkeypatch):
    """Drive every DB-backed service through a recorder that enforces psycopg's
    placeholder contract: one %s per parameter, no $N. This is the exact check
    that fails in production (psycopg) but not against the fake memory DB."""
    from grace.server.auth_service import AuthService
    from grace.server.cost_guard import CostGuardService
    from grace.server.free_sessions import FreeSessionService, utc_day
    from grace.server.usage import UsageService

    real_db = memory_db["db"]
    executed = []

    def recording_db(sql: str, params: list | None = None):
        params = params or []
        assert _DOLLAR_PLACEHOLDER.search(sql) is None, f"$N placeholder in: {sql}"
        assert sql.count("%s") == len(params), (
            f"psycopg placeholder/param mismatch ({sql.count('%s')} placeholders "
            f"vs {len(params)} params) in: {sql}"
        )
        executed.append(sql)
        return real_db(sql, params)

    # AuthService — covers users/sessions queries.
    auth = AuthService(recording_db)
    reg = auth.register({"email": "a@example.com", "password": "password123"}, "cli", {"beta": False})
    assert reg["token"]
    auth.login({"email": "a@example.com", "password": "password123"}, "cli")
    auth.authenticate(reg["token"])
    auth.logout("bogus-token")

    # UsageService — covers the 13-placeholder agent_runs insert (including the
    # CASE WHEN branch) plus the usage insert and the recent list.
    usage = UsageService(recording_db)
    user_id = reg["user"]["id"]
    base = {
        "user_id": user_id,
        "model": "openai/gpt-oss-20b",
        "status": "done",
        "input_tokens": 10,
        "output_tokens": 5,
        "agent_turns": 1,
        "tool_calls": 0,
        "execution_time_ms": 12,
        "prompt": "hi",
    }
    usage.record_usage({**base, "client_run_id": "run-1"})
    usage.record_usage({**base, "client_run_id": "run-1"})  # duplicate → SELECT path
    usage.record_usage({**base, "client_run_id": "run-2", "status": "running"})  # CASE WHEN branch
    usage.recent_usage_for_user(user_id, 5)

    # FreeSessionService — start/query/end session rows.
    free = FreeSessionService(recording_db)
    state = free.get_state(user_id)
    assert state["sessionsUsed"] == 0
    gate = free.ensure_active_session(user_id)
    assert gate["ok"] and gate["startedNew"] is True
    assert free.ensure_active_session(user_id)["ok"]  # active → no insert
    assert free.last_session_row(user_id) is not None
    assert free.active_session_row(user_id) is not None
    free.end_active_session(user_id)

    # CostGuardService — reserve/settle/release ledger + ai_usage insert.
    monkeypatch.setenv("GROQ_API_KEY", "gsk-test")
    cost = CostGuardService(recording_db)
    gate = cost.guard_chat(
        user_id,
        {
            "model": "openai/gpt-oss-20b",
            "messages": [{"role": "user", "content": "hi"}],
            "maxTokens": 64,
        },
        None,
    )
    assert gate["ok"], gate
    cost.settle(
        gate["reservation"],
        {"provider": "groq", "model": "openai/gpt-oss-20b", "inputTokens": 10, "outputTokens": 5, "cachedInputTokens": 0},
    )
    cost.settle(gate["reservation"], None)  # release path
    cost.read_daily(user_id, utc_day(__import__("datetime").datetime.now(__import__("datetime").timezone.utc)))

    # Every DB service above must have executed at least one query.
    assert executed
