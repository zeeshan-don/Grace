"""Neon PostgreSQL client (port of src/api/db.ts).

The connection string is read from DATABASE_URL — a server-side secret that is
never sent to the CLI or the browser. The client is created lazily so the API
boots and serves /api/health even when no database is configured (health
reports database: "not_configured").

The service layer only ever sees the tiny `Db` callable surface:

    db(query, params) -> list[dict]

so it is trivially testable with a fake client (tests/helpers/memory_db.py),
exactly like the TS `Db` interface. The production implementation uses
psycopg 3 (TCP) against the Neon connection string; per-request access is
serialized with a lock so a single warm connection is safe under Vercel's
function reuse. Error codes (SQLSTATE) are preserved on the raised
`DbError` so the middleware can recognize schema errors (42P01/42703 → 503)
and the free-session service can detect unique violations (23505) — the same
contract the TS layer relied on.
"""

import os
import threading
from typing import Any, Callable

Db = Callable[[str, list | None], list[dict]]

_client: Db | None = None
_client_lock = threading.Lock()


class DbError(Exception):
    """A database error carrying the Postgres SQLSTATE (e.g. '23505')."""

    def __init__(self, sqlstate: str, message: str) -> None:
        super().__init__(message)
        self.sqlstate = sqlstate
        self.code = sqlstate  # mirrors the TS `err.code` accessor


def create_psycopg_db(connection_string: str) -> Db:
    """Build a Db callable backed by a lazily-created psycopg 3 connection.

    The connection is opened on first use and reused afterwards (warm
    instances skip the TCP handshake). A threading lock serializes access so
    concurrent requests on a shared instance never interleave on one
    connection. psycopg is imported lazily so the module (and everything that
    imports it) stays importable in environments without psycopg installed —
    e.g. the CLI, which never touches the database.
    """
    import psycopg  # type: ignore

    lock = threading.Lock()
    state: dict[str, Any] = {"conn": None}

    def _connection():
        if state["conn"] is None or state["conn"].closed:
            state["conn"] = psycopg.connect(connection_string)
        return state["conn"]

    def db(query: str, params: list | None = None) -> list[dict]:
        with lock:
            conn = _connection()
            with conn.cursor() as cur:
                try:
                    cur.execute(query, params or [])
                except Exception as err:  # psycopg.Error → preserve SQLSTATE
                    sqlstate = getattr(err, "sqlstate", None) or getattr(getattr(err, "diag", None), "sqlstate", None)
                    raise DbError(sqlstate or "XXXXX", str(err))
                if cur.description is None:
                    conn.commit()
                    return []
                rows = cur.fetchall()
                cols = [d.name for d in cur.description]
                conn.commit()
                return [dict(zip(cols, row)) for row in rows]

    return db


def get_db(connection_string: str | None = None) -> Db | None:
    """Create (once) or return the shared client for the given connection string."""
    global _client
    if connection_string is None:
        connection_string = (os.environ.get("DATABASE_URL") or "").strip() or None
    if connection_string and _client is None:
        with _client_lock:
            if _client is None:
                _client = create_psycopg_db(connection_string)
    return _client


def set_db_for_tests(db: Db | None) -> None:
    """Test hook: replace the shared client (used by the backend tests)."""
    global _client
    _client = db
