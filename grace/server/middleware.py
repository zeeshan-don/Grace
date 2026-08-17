"""Shared HTTP middleware (port of src/api/middleware.ts): CORS + preflight,
secret-safe error handling and request logging. Applied to every route on both
the local dev server (grace/server/serve.py) and the Vercel functions
(api/*.py), so behavior is identical locally and in production.
"""

import os
import time

from grace.server.log import log_api_event
from grace.server.types import HttpError

POSTGRES_SCHEMA_CODES = {"42P01", "42703"}
POSTGRES_PRIVILEGE_CODES = {"42501"}


def _is_postgres_schema_error(err: Exception) -> bool:
    """True when a Postgres error means the schema is missing or mismatched
    (an unapplied/partial migration), so the failure is actionable rather than
    a mystery 500:
      - 42P01 undefined_table     (e.g. relation "daily_cost" does not exist)
      - 42703 undefined_column    (a column referenced by a query is missing)
    Never triggers for connection/auth/query errors — those stay generic 500s.
    """
    code = getattr(err, "code", None) or getattr(err, "sqlstate", None)
    return code in POSTGRES_SCHEMA_CODES


def _is_postgres_privilege_error(err: Exception) -> bool:
    """True when the DATABASE_URL role can connect but has no privileges on a
    table/schema (42501 insufficient_privilege) — a misconfigured deployment
    (wrong role, wrong database, missing grants), not a code bug. Surfaced as
    an actionable 503 instead of a mystery 500."""
    code = getattr(err, "code", None) or getattr(err, "sqlstate", None)
    return code in POSTGRES_PRIVILEGE_CODES


def cors_origin() -> str:
    """CORS origin for browser clients; default '*' (the CLI is not a browser
    and is unaffected)."""
    return (os.environ.get("ZEESH_CORS_ORIGIN") or "").strip() or "*"


def apply_cors(res) -> None:
    """Set CORS headers on a response (idempotent)."""
    res.set_header("Access-Control-Allow-Origin", cors_origin())
    res.set_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS,PUT,DELETE")
    res.set_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
    res.set_header("Access-Control-Expose-Headers", "Retry-After")
    res.set_header("Vary", "Origin")


def with_http(handler):
    """Wrap a handler with:
      - CORS headers + OPTIONS preflight (204),
      - safe error responses (no stack traces or internals reach clients;
        sanitized details go to the log only),
      - a request log line (method, path, status, latency, plus any detail the
        handler chose to emit through log_api_event).
    """
    def wrapped(req: dict, res) -> None:
        started_at_ms = time.time() * 1000
        status = 200
        error_detail = None

        apply_cors(res)

        if req.get("method") == "OPTIONS":
            res.status(204).send("")
            log_api_event(
                {
                    "method": req.get("method"),
                    "path": req.get("pathname") or req.get("url") or "/",
                    "status": 204,
                    "latencyMs": int(time.time() * 1000 - started_at_ms),
                }
            )
            return

        # Capture the status the handler sets (both runtimes' res expose .status()).
        original_status = res.status

        def tracking_status(code):
            nonlocal status
            status = code
            return original_status(code)

        res.status = tracking_status

        try:
            handler(req, res)
        except HttpError as err:
            # Intentional 4xx/5xx with a designed message (e.g. body too large).
            status = err.status
            res.status(err.status).json({"error": err.message})
        except Exception as err:
            if _is_postgres_schema_error(err):
                # The server DB is missing a table/column — almost always an
                # unapplied migration, not a code bug. Give ops a clear,
                # secret-free pointer instead of a silent 500 (which the CLI
                # would read as a mystery failure). The concrete SQLSTATE goes
                # to the log only.
                status = 503
                error_detail = str(err)
                res.status(503).json(
                    {
                        "error": (
                            "The server database is missing required tables or columns — run "
                            "the database migrations (db/migrations/*.sql) and redeploy. "
                            "Details were logged server-side."
                        ),
                    }
                )
            elif _is_postgres_privilege_error(err):
                # The DATABASE_URL role connects but cannot touch the tables —
                # a misconfigured DATABASE_URL (wrong role/database) or missing
                # grants, not a code bug. Actionable 503; the SQLSTATE goes to
                # the log only.
                status = 503
                error_detail = str(err)
                res.status(503).json(
                    {
                        "error": (
                            "The server database user cannot access the required tables — check "
                            "the DATABASE_URL role and grants (the migrations must be applied "
                            "by a role with privileges on the database). Details were logged server-side."
                        ),
                    }
                )
            else:
                # Unexpected failure: never leak internals to the client.
                status = 500
                error_detail = str(err)
                res.status(500).json({"error": "Internal server error."})
        finally:
            log_api_event(
                {
                    "method": req.get("method"),
                    "path": req.get("pathname") or req.get("url") or "/",
                    "status": status,
                    "latencyMs": int(time.time() * 1000 - started_at_ms),
                    "detail": error_detail,
                }
            )

    return wrapped
