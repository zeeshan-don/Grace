"""Shared HTTP types for the GRACE API layer (port of src/api/types.ts).

The handlers use a tiny request/response abstraction so the same handlers run
unchanged on Vercel (api/*.py WSGI functions) and in the local dev server
(grace/server/serve.py, WSGI + wsgiref). This mirrors the TS design where the
handlers were shared between api/*.ts and the local node:http server.
"""

from typing import Any


class HttpError(Exception):
    """An intentional HTTP error with a designed, client-safe message (used by
    the request adapter for body-size/JSON-parse failures). Other errors are
    converted to a generic 500 by the middleware — never leaked to clients."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status

    @property
    def message(self) -> str:
        """Mirrors the TS `err.message` accessor."""
        return str(self.args[0]) if self.args else ""


def is_object(v: Any) -> bool:
    """True for plain JSON objects (not arrays, not None)."""
    return isinstance(v, dict)


def method_not_allowed(res, allow: str) -> None:
    """Respond 405 with the allowed methods."""
    res.set_header("Allow", allow).status(405).json({"error": f"Method not allowed. Use {allow}."})
