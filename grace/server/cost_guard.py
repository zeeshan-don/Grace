"""GRACE FREE internal cost guard (port of src/api/costGuard.ts).

Enforces the per-user daily cost ceiling (₹20/day, configurable) and the
global hosted spending circuit breaker BEFORE any paid provider request is
sent, using request RESERVATIONS so a huge model response can never overshoot
the ceiling:

  remaining budget
      ↓
  estimate worst-case cost (input + max output across the provider chain)
      ↓
  cap max output tokens to the remaining budget
      ↓
  reserve a conservative amount (atomic, race-safe)
      ↓
  make the API call (max output already bounded)
      ↓
  receive actual usage → settle actual cost → release unused reservation

Race safety: reservations are single-statement atomic UPSERTs whose WHERE
clause re-checks the ceiling (`spent + reserved + new <= cap`), so concurrent
requests can never push a user over the ceiling. Money is stored as INTEGER
microdollars (grace/costs/money.py) and prices come from the central registry
(grace/costs/pricing.py). The user-facing messages never reveal spending.

The guard runs BEFORE the free-session gate in /api/provider: a request
refused here consumes no session slot ("do not waste sessions").
"""

import json
import math
import os
from datetime import datetime, timezone

from grace.costs.money import inr_to_usd_micros
from grace.costs.pricing import (
    estimate_cost_micros,
    output_micros_per_1m_for,
    price_for_model,
    tier_for_context,
)
from grace.server.db import Db
from grace.server.free_sessions import utc_day

DEFAULT_DAILY_COST_LIMIT_INR = 20
DEFAULT_INR_PER_USD = 83
MIN_OUTPUT_TOKENS = 64
DEFAULT_MAX_OUTPUT_TOKENS = 4096


def _env_non_negative_float(name: str, fallback: float) -> float:
    """Read a non-negative env number (INR limits are decimal currency), else fallback."""
    try:
        raw = float(os.environ.get(name) or "")
    except (TypeError, ValueError):
        return fallback
    return raw if math.isfinite(raw) and raw >= 0 else fallback


def _ts_round(x: float) -> int:
    """Math.round semantics (half away from zero) — Python's round() is banker's."""
    return int(math.floor(x + 0.5))


class CostGuardService:
    def __init__(self, db: Db, options: dict | None = None) -> None:
        self.db = db
        self.options = options or {}

    def now(self) -> datetime:
        return self.options.get("now", lambda: datetime.now(timezone.utc))()

    def _daily_cap_micros(self) -> int:
        """Per-user daily ceiling in USD microdollars (0 = disabled)."""
        inr = _env_non_negative_float("ZEESH_DAILY_COST_LIMIT_INR", DEFAULT_DAILY_COST_LIMIT_INR)
        rate = _env_non_negative_float("ZEESH_INR_PER_USD", DEFAULT_INR_PER_USD)
        return inr_to_usd_micros(inr, rate)

    def _global_daily_cap_micros(self) -> int:
        return inr_to_usd_micros(_env_non_negative_float("ZEESH_GLOBAL_DAILY_COST_LIMIT_INR", 0))

    def _global_monthly_cap_micros(self) -> int:
        return inr_to_usd_micros(_env_non_negative_float("ZEESH_GLOBAL_MONTHLY_COST_LIMIT_INR", 0))

    # -------------------------------------------------------------------------

    def guard_chat(self, user_id: str, req: dict, session_id: str | None) -> dict:
        """Gate a chat request: estimate worst-case cost across the provider
        chain, cap max output tokens to the remaining budget, reserve budget
        atomically (per-user daily + global daily/monthly) and return the
        reservation. Refusals happen BEFORE any session slot is consumed."""
        from grace.server.providers import configured_provider_chain

        now = self.now()
        day = utc_day(now)
        month = day[:7]

        chain = configured_provider_chain(req.get("model"), req.get("tier"))
        if not chain:
            return {
                "ok": False,
                "status": 503,
                "code": "no_providers",
                "error": (
                    "No server-side AI provider key is configured (set GROQ_API_KEY, "
                    "NVIDIA_API_KEY, GEMINI_API_KEY and/or MINIMAX_API_KEY)."
                ),
            }

        daily_cap = self._daily_cap_micros()
        global_daily_cap = self._global_daily_cap_micros()
        global_monthly_cap = self._global_monthly_cap_micros()

        # Worst-case estimate across the chain: the highest input cost and the
        # highest output price among the providers that could serve this
        # request. The input bound is CONSERVATIVE: tokenizers never exceed ~1
        # token per character, so the raw serialized length is a safe ceiling
        # for input tokens (a chars/4 estimate could under-reserve).
        input_tokens = len(
            json.dumps(
                {"messages": req.get("messages") or [], "tools": req.get("tools") or []},
                separators=(",", ":"),
            )
        )
        requested_max = req.get("maxTokens") or DEFAULT_MAX_OUTPUT_TOKENS
        context_probe = input_tokens + requested_max
        worst_input_micros = 0
        worst_output_per_1m = 0
        for leg in chain:
            price = price_for_model(leg["provider"], leg["model"])
            tier = tier_for_context(price, context_probe)
            worst_input_micros = max(
                worst_input_micros,
                _ts_round((input_tokens * tier["inputMicrosPer1M"]) / 1_000_000),
            )
            worst_output_per_1m = max(
                worst_output_per_1m,
                output_micros_per_1m_for(leg["provider"], leg["model"], context_probe),
            )

        max_output = requested_max
        if daily_cap > 0:
            spent_reserved = self.read_daily(user_id, day)
            available = max(0, daily_cap - spent_reserved["spent"] - spent_reserved["reserved"])
            if available <= 0:
                return self._daily_refusal(now)
            after_input = available - worst_input_micros
            if after_input <= 0:
                return self._daily_refusal(now)
            # Max output the remaining budget allows (never exceed the request's own cap).
            budget_max = math.floor((after_input * 1_000_000) / worst_output_per_1m) if worst_output_per_1m > 0 else requested_max
            max_output = min(requested_max, budget_max)
            if max_output < MIN_OUTPUT_TOKENS:
                return self._daily_refusal(now)

        # Reserve the worst case for the tokens we are about to allow.
        reserve_micros = (
            worst_input_micros + math.floor((max_output * worst_output_per_1m) / 1_000_000)
            if daily_cap > 0
            else 0
        )

        # 1. Per-user daily reservation (atomic, with the ceiling re-checked).
        if daily_cap > 0:
            ok_daily = self._reserve_daily(user_id, day, reserve_micros, daily_cap)
            if not ok_daily:
                return self._daily_refusal(now)

        # 2. Global circuit breaker reservations (daily + monthly). Pre-read the
        # global ledger so a FRESH insert can never exceed the cap (the atomic
        # reserve then re-checks under the row lock for concurrent requests).
        if global_daily_cap > 0:
            g_day = self._read_global("day", day)
            if g_day["spent"] + g_day["reserved"] + reserve_micros > global_daily_cap:
                self._release_daily(user_id, day, reserve_micros)
                return self._global_refusal(now)
            ok_global = self._reserve_global("day", day, reserve_micros, global_daily_cap)
            if not ok_global:
                self._release_daily(user_id, day, reserve_micros)
                return self._global_refusal(now)
        if global_monthly_cap > 0:
            g_month = self._read_global("month", month)
            if g_month["spent"] + g_month["reserved"] + reserve_micros > global_monthly_cap:
                self._release_daily(user_id, day, reserve_micros)
                self._release_global("day", day, reserve_micros)
                return self._global_refusal(now)
            ok_global = self._reserve_global("month", month, reserve_micros, global_monthly_cap)
            if not ok_global:
                self._release_daily(user_id, day, reserve_micros)
                self._release_global("day", day, reserve_micros)
                return self._global_refusal(now)

        reservation = {"userId": user_id, "day": day, "month": month, "reservedMicros": reserve_micros, "sessionId": session_id}
        return {"ok": True, "reservation": reservation, "maxTokens": max_output}

    def settle(self, reservation: dict | None, outcome: dict | None) -> None:
        """Settle a reservation after the request finished (or failed).
          - outcome is None      → the request failed; release the whole reservation.
          - outcome is a dict    → settle the ACTUAL cost and release the unused
                                   portion of the reservation.
        Also records the ai_usage row for internal accounting."""
        if not reservation:
            return
        actual_micros = (
            estimate_cost_micros(
                outcome["provider"],
                outcome["model"],
                {
                    "inputTokens": outcome.get("inputTokens", 0),
                    "cachedInputTokens": outcome.get("cachedInputTokens", 0),
                    "outputTokens": outcome.get("outputTokens", 0),
                },
            )
            if outcome
            else 0
        )

        self.db(
            "UPDATE daily_cost"
            "    SET spent_usd_micros = spent_usd_micros + %s,"
            "        reserved_usd_micros = GREATEST(0, reserved_usd_micros - %s),"
            "        version = version + 1,"
            "        updated_at = now()"
            "  WHERE user_id = %s AND day = %s",
            # psycopg binds positionally in SQL-text order: +spent, -reserved, user_id, day.
            [actual_micros, reservation["reservedMicros"], reservation["userId"], reservation["day"]],
        )

        self.db(
            "UPDATE global_cost"
            "    SET spent_usd_micros = spent_usd_micros + %s,"
            "        reserved_usd_micros = GREATEST(0, reserved_usd_micros - %s),"
            "        version = version + 1,"
            "        updated_at = now()"
            "  WHERE period_type = %s AND period = %s",
            [actual_micros, reservation["reservedMicros"], "day", reservation["day"]],
        )
        self.db(
            "UPDATE global_cost"
            "    SET spent_usd_micros = spent_usd_micros + %s,"
            "        reserved_usd_micros = GREATEST(0, reserved_usd_micros - %s),"
            "        version = version + 1,"
            "        updated_at = now()"
            "  WHERE period_type = %s AND period = %s",
            [actual_micros, reservation["reservedMicros"], "month", reservation["month"]],
        )

        if outcome:
            total = outcome.get("inputTokens", 0) + outcome.get("outputTokens", 0)
            self.db(
                "INSERT INTO ai_usage"
                "   (user_id, session_id, provider, model, input_tokens, cached_input_tokens,"
                "    output_tokens, total_tokens, estimated_cost_usd_micros, currency, day)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'USD', %s)",
                [
                    reservation["userId"],
                    reservation["sessionId"],
                    outcome["provider"],
                    outcome["model"],
                    outcome.get("inputTokens", 0),
                    outcome.get("cachedInputTokens", 0),
                    outcome.get("outputTokens", 0),
                    total,
                    actual_micros,
                    reservation["day"],
                ],
            )

    def read_daily(self, user_id: str, day: str) -> dict:
        """Read-only daily totals for a user (used by tests + the refusal path)."""
        rows = self.db("SELECT spent_usd_micros, reserved_usd_micros FROM daily_cost WHERE user_id = %s AND day = %s", [user_id, day])
        row = rows[0] if rows else None
        return {"spent": int(row.get("spent_usd_micros") or 0) if row else 0, "reserved": int(row.get("reserved_usd_micros") or 0) if row else 0}

    # -------------------------------------------------------------------------
    # Atomic ledger operations (single statements — race-safe)
    # -------------------------------------------------------------------------

    def _reserve_daily(self, user_id: str, day: str, micros: int, cap_micros: int) -> bool:
        """Reserve `micros` for a user/day, refusing (False) when the ceiling
        would be exceeded. Atomic: the WHERE clause re-checks the ceiling under
        the row lock, so concurrent requests can never overshoot."""
        if micros <= 0:
            return True
        rows = self.db(
            "INSERT INTO daily_cost (user_id, day, spent_usd_micros, reserved_usd_micros, version)"
            " VALUES (%s, %s, 0, %s, 1)"
            " ON CONFLICT (user_id, day) DO UPDATE"
            "   SET reserved_usd_micros = daily_cost.reserved_usd_micros + EXCLUDED.reserved_usd_micros,"
            "       version = daily_cost.version + 1,"
            "       updated_at = now()"
            "   WHERE daily_cost.spent_usd_micros + daily_cost.reserved_usd_micros + EXCLUDED.reserved_usd_micros <= %s"
            " RETURNING user_id",
            [user_id, day, micros, cap_micros],
        )
        return len(rows) == 1

    def _release_daily(self, user_id: str, day: str, micros: int) -> None:
        """Release a reservation (request failed, or a later gate refused it)."""
        if micros <= 0:
            return
        self.db(
            "UPDATE daily_cost"
            "    SET reserved_usd_micros = GREATEST(0, reserved_usd_micros - %s),"
            "        version = version + 1,"
            "        updated_at = now()"
            "  WHERE user_id = %s AND day = %s",
            [micros, user_id, day],
        )

    def _read_global(self, period_type: str, period: str) -> dict:
        """Read-only global totals for a period (used by the circuit breaker)."""
        rows = self.db(
            "SELECT spent_usd_micros, reserved_usd_micros FROM global_cost WHERE period_type = %s AND period = %s",
            [period_type, period],
        )
        row = rows[0] if rows else None
        return {"spent": int(row.get("spent_usd_micros") or 0) if row else 0, "reserved": int(row.get("reserved_usd_micros") or 0) if row else 0}

    def _reserve_global(self, period_type: str, period: str, micros: int, cap_micros: int) -> bool:
        if micros <= 0:
            return True
        rows = self.db(
            "INSERT INTO global_cost (period_type, period, spent_usd_micros, reserved_usd_micros, version)"
            " VALUES (%s, %s, 0, %s, 1)"
            " ON CONFLICT (period_type, period) DO UPDATE"
            "   SET reserved_usd_micros = global_cost.reserved_usd_micros + EXCLUDED.reserved_usd_micros,"
            "       version = global_cost.version + 1,"
            "       updated_at = now()"
            "   WHERE global_cost.spent_usd_micros + global_cost.reserved_usd_micros + EXCLUDED.reserved_usd_micros <= %s"
            " RETURNING period_type",
            [period_type, period, micros, cap_micros],
        )
        return len(rows) == 1

    def _release_global(self, period_type: str, period: str, micros: int) -> None:
        if micros <= 0:
            return
        self.db(
            "UPDATE global_cost"
            "    SET reserved_usd_micros = GREATEST(0, reserved_usd_micros - %s),"
            "        version = version + 1,"
            "        updated_at = now()"
            "  WHERE period_type = %s AND period = %s",
            [micros, period_type, period],
        )

    def _daily_refusal(self, now: datetime) -> dict:
        return {
            "ok": False,
            "status": 429,
            "code": "daily_cost_exhausted",
            "error": "Grace has reached today's usage capacity. Please try again after the daily reset.",
            "retryAfterSeconds": self._seconds_until_utc_midnight(now),
        }

    def _global_refusal(self, now: datetime) -> dict:
        return {
            "ok": False,
            "status": 429,
            "code": "global_cost_exhausted",
            "error": "Grace is temporarily at capacity. Please try again shortly.",
            "retryAfterSeconds": self._seconds_until_utc_midnight(now),
        }

    def _seconds_until_utc_midnight(self, now: datetime) -> int:
        from grace.server.free_sessions import seconds_until_utc_midnight

        return seconds_until_utc_midnight(now)
