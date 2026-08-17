"""Session authentication guard (port of src/api/auth.ts).

Protected endpoints require `Authorization: Bearer <session_token>`, where
the token was issued by POST /api/auth/login or POST /api/auth/register.
The server stores only the SHA-256 hash of the token (sessions.token_hash)
and scrypt hashes of passwords (users.password_hash) — no raw credentials
ever live server-side or in logs.
"""

import re

from grace.server.auth_service import AuthService
from grace.server.db import Db

_BEARER = re.compile(r"^Bearer\s+(.+)$", re.I)


def bearer_token(req: dict) -> str:
    """Extract the bearer token from the Authorization header (or '')."""
    header = req.get("headers", {}).get("authorization")
    match = _BEARER.match(header) if isinstance(header, str) else None
    return match.group(1).strip() if match else ""


def require_session(req: dict, db: Db) -> dict:
    """Authenticate the request against the sessions table. Returns the
    resolved user on success, or a 401 result otherwise."""
    token = bearer_token(req)
    if not token:
        return {"ok": False, "status": 401, "error": 'Missing bearer token. Log in first with "grace login".'}
    user = AuthService(db).authenticate(token)
    if not user:
        return {"ok": False, "status": 401, "error": 'Invalid or expired session token. Log in again with "grace login".'}
    return {"ok": True, "user": user}
