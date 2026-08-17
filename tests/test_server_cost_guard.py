"""Backend cost-guard tests (port of the TS costGuard tests).

The ₹20/day internal ceiling, worst-case reservation math, settle/release
semantics and the global circuit breaker — service-level with an injected
clock plus one endpoint-level refusal test.
"""

from datetime import datetime, timedelta, timezone

import pytest

from grace.costs.money import inr_to_usd_micros
from grace.server.cost_guard import CostGuardService
from tests.helpers.wsgi_client import wsgi_call

NOW = datetime(2026, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
DEFAULT_CAP_MICROS = inr_to_usd_micros(20, 83)  # 240_964
AUTH = {"Content-Type": "application/json"}


def _guard(db, **opts):
    return CostGuardService(db, {"now": lambda: NOW, **opts})


def _chat_request(**overrides):
    req = {"messages": [{"role": "user", "content": "hello"}], "model": "openai/gpt-oss-20b"}
    req.update(overrides)
    return req


def _seed_daily(memory_db_state, user_id, day, spent, reserved=0):
    # Push directly into the ledger (the memory db's INSERT treats values as a
    # reservation, matching the real atomic UPSERT semantics).
    memory_db_state["daily_costs"].append(
        {"user_id": user_id, "day": day, "spent": spent, "reserved": reserved, "version": 1}
    )


def test_no_providers_refuses_before_any_budget(memory_db):
    gate = _guard(memory_db["db"]).guard_chat("u1", _chat_request(), None)
    assert gate["ok"] is False
    assert gate["status"] == 503
    assert gate["code"] == "no_providers"
    assert len(memory_db["state"]["daily_costs"]) == 0


def test_guard_reserves_budget_and_bounds_max_tokens(memory_db, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    gate = _guard(memory_db["db"]).guard_chat("u1", _chat_request(), None)
    assert gate["ok"] is True
    reservation = gate["reservation"]
    assert reservation["reservedMicros"] > 0
    assert reservation["day"] == "2026-06-01"
    assert reservation["month"] == "2026-06"
    # The reserved budget is reflected in the ledger.
    ledger = memory_db["state"]["daily_costs"][0]
    assert ledger["reserved"] == reservation["reservedMicros"]
    # maxTokens is bounded by the request's own cap when the budget allows.
    assert gate["maxTokens"] == 4096


def test_daily_cap_refuses_when_exhausted(memory_db, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    _seed_daily(memory_db["state"], "u1", "2026-06-01", spent=DEFAULT_CAP_MICROS)
    gate = _guard(memory_db["db"]).guard_chat("u1", _chat_request(), None)
    assert gate["ok"] is False
    assert gate["status"] == 429
    assert gate["code"] == "daily_cost_exhausted"
    assert gate["retryAfterSeconds"] == 12 * 3600
    # No extra row was created and nothing was reserved.
    assert memory_db["state"]["daily_costs"][0]["reserved"] == 0


def test_tiny_remaining_budget_refuses(memory_db, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    # Leave so little budget that even the 64-token minimum output can't fit.
    _seed_daily(memory_db["state"], "u1", "2026-06-01", spent=DEFAULT_CAP_MICROS - 20)
    gate = _guard(memory_db["db"]).guard_chat("u1", _chat_request(), None)
    assert gate["ok"] is False
    assert gate["code"] == "daily_cost_exhausted"


def test_max_tokens_capped_to_budget(memory_db, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    # Leave ~1000 micros: enough for a real response, but far below what a
    # 4096-token output at $0.40/1M (~1638 micros) would cost.
    _seed_daily(memory_db["state"], "u1", "2026-06-01", spent=DEFAULT_CAP_MICROS - 1_000, reserved=0)
    gate = _guard(memory_db["db"]).guard_chat("u1", _chat_request(maxTokens=4096), None)
    assert gate["ok"] is True
    assert gate["maxTokens"] < 4096
    assert gate["maxTokens"] >= 64


def test_settle_actual_cost_and_release_unused_reservation(memory_db, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    svc = _guard(memory_db["db"])
    gate = svc.guard_chat("u1", _chat_request(), None)
    reservation = gate["reservation"]
    svc.settle(
        reservation,
        {"provider": "groq", "model": "openai/gpt-oss-20b", "inputTokens": 500, "cachedInputTokens": 0, "outputTokens": 300},
    )
    ledger = memory_db["state"]["daily_costs"][0]
    assert ledger["reserved"] == 0  # fully released
    assert ledger["spent"] > 0  # actual cost settled
    # The ai_usage accounting row was recorded.
    assert len(memory_db["state"]["ai_usage"]) == 1
    assert memory_db["state"]["ai_usage"][0]["provider"] == "groq"
    assert memory_db["state"]["ai_usage"][0]["day"] == "2026-06-01"


def test_settle_failure_releases_full_reservation(memory_db, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    svc = _guard(memory_db["db"])
    gate = svc.guard_chat("u1", _chat_request(), None)
    svc.settle(gate["reservation"], None)
    ledger = memory_db["state"]["daily_costs"][0]
    assert ledger["reserved"] == 0
    assert ledger["spent"] == 0
    assert len(memory_db["state"]["ai_usage"]) == 0


def test_global_daily_breaker(memory_db, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    monkeypatch.setenv("ZEESH_GLOBAL_DAILY_COST_LIMIT_INR", "0.0001")
    svc = _guard(memory_db["db"])
    gate = svc.guard_chat("u1", _chat_request(), None)
    assert gate["ok"] is False
    assert gate["code"] == "global_cost_exhausted"
    # The per-user reservation was rolled back (released to zero).
    assert memory_db["state"]["daily_costs"][0]["reserved"] == 0
    assert memory_db["state"]["daily_costs"][0]["spent"] == 0


def test_global_monthly_breaker(memory_db, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    monkeypatch.setenv("ZEESH_GLOBAL_MONTHLY_COST_LIMIT_INR", "0.0001")
    svc = _guard(memory_db["db"])
    gate = svc.guard_chat("u1", _chat_request(), None)
    assert gate["ok"] is False
    assert gate["code"] == "global_cost_exhausted"
    # Both the daily and monthly global reservations are absent.
    assert memory_db["state"]["global_costs"] == []


def test_disabled_daily_cap_skips_reservation(memory_db, monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    monkeypatch.setenv("ZEESH_DAILY_COST_LIMIT_INR", "0")
    gate = _guard(memory_db["db"]).guard_chat("u1", _chat_request(), None)
    assert gate["ok"] is True
    assert gate["reservation"]["reservedMicros"] == 0
    assert memory_db["state"]["daily_costs"] == []


def test_endpoint_daily_cost_exhausted(memory_db, wsgi_app, monkeypatch):
    """POST /api/provider returns 429 daily_cost_exhausted when the user's
    daily budget is spent — BEFORE any session slot is consumed."""
    from grace.server.free_sessions import utc_day

    monkeypatch.setenv("GROQ_API_KEY", "test-key")
    res = wsgi_call(wsgi_app, "POST", "/api/auth/register", headers=AUTH, body={"email": "u@example.com", "password": "password123"})
    token = res.json["token"]
    user_id = res.json["user"]["id"]
    # Seed the ledger for the REAL current UTC day (the handler uses the real clock).
    _seed_daily(memory_db["state"], user_id, utc_day(datetime.now(timezone.utc)), spent=DEFAULT_CAP_MICROS)

    res = wsgi_call(
        wsgi_app,
        "POST",
        "/api/provider",
        headers={"Authorization": f"Bearer {token}", **AUTH},
        body={"messages": [{"role": "user", "content": "hi"}]},
    )
    assert res.status == 429
    assert res.json["code"] == "daily_cost_exhausted"
    assert res.retry_after
    # The refusal consumed no free session.
    assert len(memory_db["state"]["free_sessions"]) == 0
