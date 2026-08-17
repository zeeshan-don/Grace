"""In-memory Db for backend integration tests (port of tests/helpers/memoryDb.ts).

Implements the exact query strings used by AuthService, UsageService,
FreeSessionService and CostGuardService so endpoint tests exercise the full
request → handler → service → SQL path without a real database. The SQL and
parameter ORDER match the Python backend's services 1:1.
"""

import uuid


class MemUniqueViolation(Exception):
    """Mirrors a Postgres UNIQUE violation (SQLSTATE 23505)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.code = "23505"
        self.sqlstate = "23505"


class MemUnhandledQuery(Exception):
    pass


def create_memory_db():
    state = {
        "next_id": 1,
        "users": [],
        "sessions": [],
        "runs": [],
        "usage_rows": [],
        "free_sessions": [],
        "daily_costs": [],
        "global_costs": [],
        "ai_usage": [],
    }

    def db(sql: str, params: list | None = None):
        params = params or []

        # Health probe.
        if "SELECT 1" in sql:
            return []

        # ---- AuthService ---------------------------------------------------
        if "INSERT INTO users" in sql:
            email, display_name, password_hash = params[0], params[1], params[2]
            is_beta = params[3] if len(params) > 3 else False
            state["users"].append(
                {
                    "id": str(uuid.uuid4()),
                    "email": email,
                    "display_name": display_name,
                    "password_hash": password_hash,
                    "is_beta": bool(is_beta),
                }
            )
            return [{"id": state["users"][-1]["id"]}]
        if "FROM users" in sql and "password_hash" in sql:
            email = params[0]
            u = next((x for x in state["users"] if x["email"] == email), None)
            return (
                [{"id": u["id"], "email": u["email"], "display_name": u["display_name"], "password_hash": u["password_hash"]}]
                if u
                else []
            )
        if "SELECT id FROM users" in sql:
            email = params[0]
            u = next((x for x in state["users"] if x["email"] == email), None)
            return [{"id": u["id"]}] if u else []
        if "INSERT INTO sessions" in sql:
            user_id, token_hash, device, expires_at = params[0], params[1], params[2], params[3]
            state["sessions"].append(
                {"id": str(uuid.uuid4()), "user_id": user_id, "token_hash": token_hash, "device": device, "expires_at": expires_at}
            )
            return [{"id": state["next_id"]}]
        if "DELETE FROM sessions" in sql:
            token_hash = params[0]
            state["sessions"] = [s for s in state["sessions"] if s["token_hash"] != token_hash]
            return []
        if "JOIN users" in sql:
            token_hash = params[0]
            s = next((x for x in state["sessions"] if x["token_hash"] == token_hash), None)
            if not s:
                return []
            u = next((x for x in state["users"] if x["id"] == s["user_id"]), None)
            if not u:
                return []
            return [{"id": u["id"], "email": u["email"], "display_name": u["display_name"], "expires_at": s["expires_at"]}]

        # ---- UsageService --------------------------------------------------
        if "INSERT INTO agent_runs" in sql:
            client_run_id = params[0]
            if client_run_id and any(r["client_run_id"] == client_run_id for r in state["runs"]):
                return []  # ON CONFLICT DO NOTHING
            run = {
                "id": state["next_id"],
                "client_run_id": client_run_id,
                "user_id": params[1],
                "model": params[6],
                "input_tokens": params[9],
                "output_tokens": params[10],
            }
            state["next_id"] += 1
            state["runs"].append(run)
            return [{"id": run["id"]}]
        if "SELECT id FROM agent_runs" in sql:
            client_run_id = params[0]
            r = next((x for x in state["runs"] if x["client_run_id"] == client_run_id), None)
            return [{"id": r["id"]}] if r else []
        if "INSERT INTO usage" in sql:
            user_id, run_id, model, input_tokens, output_tokens = params[0], params[1], params[2], params[3], params[4]
            state["usage_rows"].append(
                {
                    "id": state["next_id"],
                    "user_id": user_id,
                    "run_id": run_id,
                    "model": model,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "created_at": "2026-01-01T00:00:00.000Z",
                }
            )
            state["next_id"] += 1
            return []
        if "FROM usage" in sql and "WHERE u.user_id" in sql:
            user_id = params[0]
            limit = int(params[1] or 20)
            return [
                {
                    "id": r["id"],
                    "user_id": r["user_id"],
                    "run_id": r["run_id"],
                    "model": r["model"],
                    "input_tokens": r["input_tokens"],
                    "output_tokens": r["output_tokens"],
                    "created_at": r["created_at"],
                }
                for r in state["usage_rows"]
                if r["user_id"] == user_id
            ][:limit]

        # ---- FreeSessionService -------------------------------------------
        if "INSERT INTO free_sessions" in sql:
            user_id, day, session_number, started_at, expires_at = params[0], params[1], params[2], params[3], params[4]
            conflict = any(
                s["user_id"] == user_id and s["day"] == day and s["session_number"] == session_number
                for s in state["free_sessions"]
            )
            if conflict:
                raise MemUniqueViolation('duplicate key value violates unique constraint "free_sessions"')
            row = {
                "id": str(uuid.uuid4()),
                "user_id": user_id,
                "day": day,
                "session_number": session_number,
                "started_at": started_at,
                "expires_at": expires_at,
                "ended_at": None,
            }
            state["free_sessions"].append(row)
            return [
                {
                    "id": row["id"],
                    "user_id": row["user_id"],
                    "day": row["day"],
                    "session_number": row["session_number"],
                    "started_at": row["started_at"],
                    "expires_at": row["expires_at"],
                    "ended_at": row["ended_at"],
                }
            ]
        if "FROM free_sessions" in sql:
            user_id, day = params[0], params[1]
            rows = [s for s in state["free_sessions"] if s["user_id"] == user_id and s["day"] == day]
            rows.sort(key=lambda s: s["session_number"])
            return [
                {
                    "id": s["id"],
                    "user_id": s["user_id"],
                    "day": s["day"],
                    "session_number": s["session_number"],
                    "started_at": s["started_at"],
                    "expires_at": s["expires_at"],
                    "ended_at": s["ended_at"],
                }
                for s in rows
            ]
        if "UPDATE free_sessions" in sql:
            # Lazy end (_mark_ended) passes only the id → ended_at = expires_at.
            # Explicit end (end_active_session) passes [ended_at, id] in SQL-text
            # order (psycopg is positional).
            if len(params) > 1:
                ended_at, row_id = params[0], params[1]
            else:
                ended_at, row_id = None, params[0]
            row = next((s for s in state["free_sessions"] if s["id"] == row_id), None)
            if row and row["ended_at"] is None:
                row["ended_at"] = ended_at if ended_at is not None else row["expires_at"]
            return []

        # ---- CostGuardService ----------------------------------------------
        if "INSERT INTO daily_cost" in sql:
            user_id, day, micros, cap_micros = params[0], params[1], params[2], params[3]
            row = next((r for r in state["daily_costs"] if r["user_id"] == user_id and r["day"] == day), None)
            if row:
                if row["spent"] + row["reserved"] + micros > cap_micros:
                    return []  # WHERE false → no row
                row["reserved"] += micros
                row["version"] += 1
                return [{"user_id": user_id}]
            state["daily_costs"].append({"user_id": user_id, "day": day, "spent": 0, "reserved": micros, "version": 1})
            return [{"user_id": user_id}]
        if "UPDATE daily_cost" in sql:
            # Settle passes 4 params in SQL-text order [spentDelta, reservedDelta,
            # user_id, day]; the release path passes 3 [reservedDelta, user_id, day].
            if len(params) >= 4:
                spent_delta, reserved_delta, user_id, day = params[0], params[1], params[2], params[3]
            else:
                reserved_delta, user_id, day = params[0], params[1], params[2]
                spent_delta = 0
            reserved_delta = reserved_delta or 0
            row = next((r for r in state["daily_costs"] if r["user_id"] == user_id and r["day"] == day), None)
            if row:
                row["spent"] += spent_delta
                row["reserved"] = max(0, row["reserved"] - reserved_delta)
                row["version"] += 1
            return []
        if "FROM daily_cost" in sql:
            user_id, day = params[0], params[1]
            row = next((r for r in state["daily_costs"] if r["user_id"] == user_id and r["day"] == day), None)
            return [{"spent_usd_micros": row["spent"], "reserved_usd_micros": row["reserved"]}] if row else []
        if "INSERT INTO global_cost" in sql:
            period_type, period, micros, cap_micros = params[0], params[1], params[2], params[3]
            row = next((r for r in state["global_costs"] if r["period_type"] == period_type and r["period"] == period), None)
            if row:
                if row["spent"] + row["reserved"] + micros > cap_micros:
                    return []
                row["reserved"] += micros
                row["version"] += 1
                return [{"period_type": period_type}]
            state["global_costs"].append({"period_type": period_type, "period": period, "spent": 0, "reserved": micros, "version": 1})
            return [{"period_type": period_type}]
        if "UPDATE global_cost" in sql:
            # Same text-order contract as daily_cost: settle = [spentDelta,
            # reservedDelta, period_type, period]; release = [reservedDelta,
            # period_type, period].
            if len(params) >= 4:
                spent_delta, reserved_delta, period_type, period = params[0], params[1], params[2], params[3]
            else:
                reserved_delta, period_type, period = params[0], params[1], params[2]
                spent_delta = 0
            reserved_delta = reserved_delta or 0
            row = next((r for r in state["global_costs"] if r["period_type"] == period_type and r["period"] == period), None)
            if row:
                row["spent"] += spent_delta
                row["reserved"] = max(0, row["reserved"] - reserved_delta)
                row["version"] += 1
            return []
        if "FROM global_cost" in sql:
            period_type, period = params[0], params[1]
            row = next((r for r in state["global_costs"] if r["period_type"] == period_type and r["period"] == period), None)
            return [{"spent_usd_micros": row["spent"], "reserved_usd_micros": row["reserved"]}] if row else []

        if "INSERT INTO ai_usage" in sql:
            state["ai_usage"].append(
                {
                    "user_id": params[0],
                    "session_id": params[1],
                    "provider": params[2],
                    "model": params[3],
                    "input_tokens": params[4],
                    "cached_input_tokens": params[5],
                    "output_tokens": params[6],
                    "total_tokens": params[7],
                    "estimated_cost_usd_micros": params[8],
                    "day": params[9],
                }
            )
            return []

        raise MemUnhandledQuery(f"MemoryDb: unhandled query: {sql}")

    return {"db": db, "state": state}
