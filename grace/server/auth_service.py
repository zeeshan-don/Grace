"""Authentication service (port of src/api/authService.ts).

DB-backed account + session operations: register, login, logout and
authenticate (resolve a bearer token to a user). Used by both the API
handlers and the tests. Passwords are scrypt-hashed (grace/server/password.py);
sessions store only the SHA-256 of the token (grace/server/sessions.py).
"""

import re
from datetime import datetime, timedelta, timezone

from grace.server.db import Db
from grace.server.password import hash_password, verify_password
from grace.server.sessions import generate_session_token, hash_session_token

SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000  # sessions live 30 days
MIN_PASSWORD_LENGTH = 8
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class AuthError(Exception):
    """A 4xx/5xx auth error carrying an HTTP status."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status

    @property
    def message(self) -> str:
        """Mirrors the TS `err.message` accessor."""
        return str(self.args[0]) if self.args else ""


class AuthService:
    def __init__(self, db: Db) -> None:
        self.db = db

    def register(self, input_: dict, device: str = "cli", opts: dict | None = None) -> dict:
        """Create an account and an initial session. Returns {user, token, expiresAt}."""
        opts = opts or {}
        email = normalize_email(input_.get("email"))
        if not email:
            raise AuthError(400, '"email" must be a valid email address.')
        password = input_.get("password") or ""
        if len(password) < MIN_PASSWORD_LENGTH:
            raise AuthError(400, f"Password must be at least {MIN_PASSWORD_LENGTH} characters.")
        display_name = input_.get("displayName")
        display_name = display_name.strip() if isinstance(display_name, str) and display_name.strip() else None

        existing = self.db("SELECT id FROM users WHERE email = $1", [email])
        if existing:
            raise AuthError(409, "An account with this email already exists.")

        if opts.get("beta"):
            inserted = self.db(
                "INSERT INTO users (email, display_name, password_hash, is_beta) VALUES ($1, $2, $3, $4) RETURNING id",
                [email, display_name, hash_password(password), True],
            )
        else:
            inserted = self.db(
                "INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id",
                [email, display_name, hash_password(password)],
            )
        user_id = str(inserted[0].get("id") or "") if inserted else ""
        if not user_id:
            raise AuthError(500, "Could not create the account.")

        return self._create_session({"id": user_id, "email": email, "displayName": display_name}, device)

    def login(self, input_: dict, device: str = "cli") -> dict:
        """Verify credentials and open a new session."""
        email = normalize_email(input_.get("email"))
        password = input_.get("password") or ""
        if not email or not password:
            raise AuthError(400, '"email" and "password" are required.')
        rows = self.db("SELECT id, email, display_name, password_hash FROM users WHERE email = $1", [email])
        row = rows[0] if rows else None
        if not row:
            raise AuthError(401, "Invalid email or password.")

        stored = str(row.get("password_hash") or "")
        if not stored or not verify_password(password, stored):
            raise AuthError(401, "Invalid email or password.")
        return self._create_session(
            {
                "id": str(row.get("id")),
                "email": str(row.get("email")),
                "displayName": row.get("display_name") if row.get("display_name") is not None else None,
            },
            device,
        )

    def logout(self, token: str) -> bool:
        """Invalidate a session. Returns False when the token was not found."""
        if not token:
            return False
        self.db("DELETE FROM sessions WHERE token_hash = $1", [hash_session_token(token)])
        return True

    def authenticate(self, token: str) -> dict | None:
        """Resolve a raw bearer token to a user, or None when invalid/expired."""
        if not token:
            return None
        rows = self.db(
            "SELECT u.id, u.email, u.display_name, s.expires_at"
            "  FROM sessions s"
            "  JOIN users u ON u.id = s.user_id"
            " WHERE s.token_hash = $1",
            [hash_session_token(token)],
        )
        row = rows[0] if rows else None
        if not row:
            return None
        expires_at = _parse_iso_ms(str(row.get("expires_at") or ""))
        if expires_at is None or expires_at <= _now_ms():
            return None
        return {
            "id": str(row.get("id")),
            "email": str(row.get("email")),
            "displayName": row.get("display_name") if row.get("display_name") is not None else None,
        }

    def _create_session(self, user: dict, device: str) -> dict:
        token = generate_session_token()
        expires_at = datetime.fromtimestamp((_now_ms() + SESSION_TTL_MS) / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        self.db(
            "INSERT INTO sessions (user_id, token_hash, device, expires_at) VALUES ($1, $2, $3, $4)",
            [user["id"], hash_session_token(token), device, expires_at],
        )
        return {"user": user, "token": token, "expiresAt": expires_at}


def normalize_email(email) -> str:
    """Normalize + validate an email ('' when invalid). Shared with the handlers."""
    if not isinstance(email, str):
        return ""
    trimmed = email.strip().lower()
    return trimmed if EMAIL_RE.match(trimmed) else ""


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _parse_iso_ms(value: str) -> int | None:
    """Parse an ISO timestamp to epoch ms, or None when unparseable."""
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return int(dt.timestamp() * 1000)
    except (ValueError, TypeError):
        return None
