"""GRACE FREE daily session service (port of src/api/freeSessions.ts).

Enforces the free plan on the server — the CLI never stores or trusts any
session state, so restarting it or deleting local files can never reset the
daily quota:

  * 3 sessions per user per day        (ZEESH_SESSIONS_PER_DAY, default 3)
  * 60 minutes per session             (ZEESH_SESSION_DURATION_MINUTES, default 60)
  * 3 hours / day max                  (sessionsPerDay × sessionDuration)
  * day boundary = 00:00 UTC           (server-authoritative, timezone-independent)

State lives in Neon `free_sessions` (db/migrations/004_free_sessions.sql):
one row per session with a UNIQUE (user_id, day, session_number) constraint,
which is what makes the "start the next session" step race-safe (concurrent
requests that both pick the same number collide → the loser retries with the
new MAX).

API:
  - get_state(userId)            read-only summary for GET /api/usage.
  - ensure_active_session(userId) the authoritative gate for /api/provider:
      · active session   → serve the request inside it,
      · expired / none   → auto-start the next session if quota remains
                           ("automatically move the user to the next
                           session"), otherwise refuse with
                           `{ code: 'daily_limit_exhausted' }`.
"""

import math
import os
from datetime import datetime, timezone

from grace.server.db import Db

DEFAULT_SESSIONS_PER_DAY = 3
DEFAULT_SESSION_DURATION_MS = 60 * 60 * 1000  # 60 minutes
MAX_START_ATTEMPTS = 10


def utc_day(d: datetime) -> str:
    """The UTC date bucket a session belongs to (YYYY-MM-DD). The day boundary
    is deliberately UTC — the server's authoritative day is the same for every
    user regardless of timezone, so quota math is unambiguous."""
    return d.astimezone(timezone.utc).strftime("%Y-%m-%d")


def seconds_until_utc_midnight(now: datetime | None = None) -> int:
    """Seconds until the next UTC midnight (used for the 429 Retry-After header)."""
    now = now or datetime.now(timezone.utc)
    now_ms = int(now.astimezone(timezone.utc).timestamp() * 1000)
    next_midnight = datetime(now.year, now.month, now.day, tzinfo=timezone.utc).timestamp() * 1000 + 24 * 60 * 60 * 1000
    return max(1, math.ceil((next_midnight - now_ms) / 1000))


def env_positive_int(name: str, fallback: int) -> int:
    """Read an env override as a positive integer, falling back to `fallback`."""
    try:
        raw = float(os.environ.get(name) or "")
    except (TypeError, ValueError):
        return fallback
    return math.floor(raw) if math.isfinite(raw) and raw > 0 else fallback


def _ts_round(x: float) -> int:
    """Math.round semantics (half away from zero) — Python's round() is banker's."""
    return int(math.floor(x + 0.5))


class FreeSessionService:
    def __init__(self, db: Db, options: dict | None = None) -> None:
        self.db = db
        self.options = options or {}

    def now(self) -> datetime:
        return self.options.get("now", lambda: datetime.now(timezone.utc))()

    @property
    def sessions_per_day(self) -> int:
        return env_positive_int("ZEESH_SESSIONS_PER_DAY", DEFAULT_SESSIONS_PER_DAY)

    @property
    def session_duration_ms(self) -> int:
        return env_positive_int("ZEESH_SESSION_DURATION_MINUTES", DEFAULT_SESSION_DURATION_MS // 60_000) * 60_000

    # -------------------------------------------------------------------------
    # Read-only state (GET /api/usage) — never mutates.
    # -------------------------------------------------------------------------

    def get_state(self, user_id: str) -> dict:
        """Daily free-plan summary for a user, computed from Neon."""
        now = self.now()
        rows = self._session_rows(user_id, utc_day(now))
        return self._compute_state(rows, now)

    def active_session_row(self, user_id: str) -> dict | None:
        """The user's currently ACTIVE session row, or None (read-only — never
        starts or ends anything). Used by GET /api/session/status."""
        now = self.now()
        rows = self._session_rows(user_id, utc_day(now))
        last = rows[-1] if rows else None
        return last if last is not None and _is_active(last, now) else None

    def last_session_row(self, user_id: str) -> dict | None:
        """The day's most recent session row, or None when the user has no
        session yet today (read-only). Lets the status endpoint distinguish an
        explicitly ended session (ended_at < expires_at) from one that expired
        naturally (ended_at == expires_at) and from no session at all."""
        rows = self._session_rows(user_id, utc_day(self.now()))
        return rows[-1] if rows else None

    def end_active_session(self, user_id: str) -> dict:
        """Explicitly end the user's active session (POST /api/session/end).
        Marks the active row ended now; never starts a replacement — ending is
        an explicit action, quota stays as-is. Idempotent: no active session is
        a no-op (the expired row is lazily marked ended)."""
        now = self.now()
        day = utc_day(now)
        rows = self._session_rows(user_id, day)
        last = rows[-1] if rows else None
        if last is not None:
            if _is_active(last, now):
                self.db(
                    "UPDATE free_sessions SET ended_at = $2 WHERE id = $1 AND ended_at IS NULL",
                    [last["id"], now.astimezone(timezone.utc).isoformat()],
                )
            else:
                self._mark_ended(last)  # lazy end of an already-expired session
        after = self._session_rows(user_id, day)
        return self._compute_state(after, now)

    def ensure_active_session(self, user_id: str) -> dict:
        """Authoritative gate for /api/provider (may auto-start the next session)."""
        now = self.now()
        day = utc_day(now)
        limit = self.sessions_per_day

        for _ in range(MAX_START_ATTEMPTS):
            rows = self._session_rows(user_id, day)
            last = rows[-1] if rows else None

            if last is not None and _is_active(last, now):
                # Current session is still live — serve inside it.
                return {"ok": True, "state": self._compute_state(rows, now), "startedNew": False}

            if len(rows) >= limit:
                # All sessions for today are used up (and the last one is expired).
                if last is not None:
                    self._mark_ended(last)  # lazy end: session expired
                return {
                    "ok": False,
                    "status": 429,
                    "code": "daily_limit_exhausted",
                    "error": (
                        f"You have used all {limit} free sessions for today "
                        f"({_ts_round((limit * self.session_duration_ms) / 3_600_000)}h max). "
                        "New sessions unlock at 00:00 UTC. Thanks for using GRACE FREE."
                    ),
                    "state": self._compute_state(rows, now),
                }

            # Expired session (or none yet) + quota remains → auto-start the next.
            session_number = len(rows) + 1
            started_at = now
            expires_at = started_at + _ms_timedelta(self.session_duration_ms)
            try:
                inserted = self.db(
                    "INSERT INTO free_sessions (user_id, day, session_number, started_at, expires_at)"
                    " VALUES ($1, $2, $3, $4, $5)"
                    " RETURNING id, user_id, day, session_number, started_at, expires_at, ended_at",
                    [user_id, day, session_number, _iso(started_at), _iso(expires_at)],
                )
                row = inserted[0] if inserted else None
                if not row:
                    raise RuntimeError("Could not start a free session.")
                # The session we just replaced expired — mark it ended (lazy expiry).
                if last is not None:
                    self._mark_ended(last)
                all_rows = list(rows) + [_to_free_session_row(row)]
                return {"ok": True, "state": self._compute_state(all_rows, now), "startedNew": True}
            except Exception as err:
                # Unique violation → another request started this number first; retry.
                if _is_unique_violation(err):
                    continue
                raise err

        # Retry budget exhausted — most likely the day filled up under contention.
        rows = self._session_rows(user_id, day)
        if len(rows) >= limit:
            return {
                "ok": False,
                "status": 429,
                "code": "daily_limit_exhausted",
                "error": f"You have used all {limit} free sessions for today. New sessions unlock at 00:00 UTC.",
                "state": self._compute_state(rows, now),
            }
        raise RuntimeError("Could not start a free session.")

    # -------------------------------------------------------------------------
    # Internals
    # -------------------------------------------------------------------------

    def _session_rows(self, user_id: str, day: str) -> list[dict]:
        rows = self.db(
            "SELECT id, user_id, day, session_number, started_at, expires_at, ended_at"
            "   FROM free_sessions"
            "  WHERE user_id = $1 AND day = $2"
            "  ORDER BY session_number ASC",
            [user_id, day],
        )
        return [_to_free_session_row(r) for r in rows]

    def _mark_ended(self, row: dict) -> None:
        """Mark a session ended (idempotent) — the DB stays an explicit record."""
        self.db("UPDATE free_sessions SET ended_at = expires_at WHERE id = $1 AND ended_at IS NULL", [row["id"]])

    def _compute_state(self, rows: list[dict], now: datetime) -> dict:
        limit = self.sessions_per_day
        duration_ms = self.session_duration_ms
        now_ms = int(now.astimezone(timezone.utc).timestamp() * 1000)

        used_seconds = 0
        for row in rows:
            start = _iso_ms(row["started_at"])
            end = _iso_ms(row["expires_at"])
            if start is None or end is None:
                continue  # unparseable timestamps are skipped, like NaN in TS
            # Elapsed so far, capped at the session's own expiry (60 min max each).
            elapsed_ms = min(now_ms, end) - start
            if elapsed_ms > 0:
                used_seconds += elapsed_ms
        # Never exceed the daily cap (guard against clock skew / overlapping rows).
        daily_limit_seconds = _ts_round((limit * duration_ms) / 1000)
        daily_used_seconds = min(_ts_round(used_seconds / 1000), daily_limit_seconds)

        last = rows[-1] if rows else None
        active = last is not None and _is_active(last, now)

        return {
            "sessionsUsed": len(rows),
            "sessionsRemaining": max(0, limit - len(rows)),
            "currentSession": last["session_number"] if active else None,
            "sessionStartedAt": last["started_at"] if active else None,
            "sessionExpiresAt": last["expires_at"] if active else None,
            "dailyUsedSeconds": daily_used_seconds,
            "dailyLimitSeconds": daily_limit_seconds,
        }


def _is_active(row: dict, now: datetime) -> bool:
    """A session is active while now < expires_at AND it was not ended early
    (POST /api/session/end sets ended_at — an explicitly ended session is never
    reused, even while its expiry is still in the future)."""
    expires_at = _iso_ms(row["expires_at"])
    ended_at = _iso_ms(row["ended_at"]) if row.get("ended_at") is not None else None
    now_ms = int(now.astimezone(timezone.utc).timestamp() * 1000)
    if expires_at is None:
        return False
    if ended_at is not None and ended_at <= now_ms:
        return False
    return expires_at > now_ms


def _is_unique_violation(err: Exception) -> bool:
    """Postgres UNIQUE violation (SQLSTATE 23505). The memory test db mirrors it."""
    return getattr(err, "code", None) == "23505" or getattr(err, "sqlstate", None) == "23505"


def _to_free_session_row(row: dict) -> dict:
    return {
        "id": str(row.get("id")),
        "user_id": str(row.get("user_id")),
        "day": str(row.get("day")),
        "session_number": int(row.get("session_number")),
        "started_at": str(row.get("started_at")),
        "expires_at": str(row.get("expires_at")),
        "ended_at": row.get("ended_at") if row.get("ended_at") is not None else None,
    }


def _iso(d: datetime) -> str:
    return d.astimezone(timezone.utc).isoformat()


def _ms_timedelta(ms: int):
    from datetime import timedelta

    return timedelta(milliseconds=ms)


def _iso_ms(value: str) -> int | None:
    """Parse an ISO timestamp to epoch ms, or None when unparseable."""
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, TypeError):
        return None
