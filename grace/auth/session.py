"""Local session persistence (port of src/auth/session.ts).

The session token from `grace login` is stored in `~/.zeesh/auth.json` with
restrictive file permissions (0o600) so other OS users cannot read it. The
token is never logged, never sent to the model, and can be wiped with
`grace logout`.
"""

import json
import os
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path

if sys.platform == "win32":
    DEFAULT_PATH = str(Path.home() / ".zeesh" / "auth.json")
else:
    DEFAULT_PATH = str(Path.home() / ".zeesh" / "auth.json")


def auth_session_path() -> str:
    return DEFAULT_PATH


def save_session(session: dict, path: str = DEFAULT_PATH) -> None:
    """Persist a session (0600). Best-effort — never break the CLI over it."""
    try:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(session, indent=2), encoding="utf-8")
        try:
            os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        except OSError:
            # Windows does not enforce POSIX modes; best-effort.
            pass
    except Exception:
        # Persistence is best-effort — the user can log in again.
        pass


def load_session(path: str = DEFAULT_PATH) -> dict | None:
    """Load the persisted session, or None when absent/corrupt."""
    try:
        p = Path(path)
        if not p.exists():
            return None
        raw = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return None
        if not raw.get("token") or not raw.get("apiUrl"):
            return None
        user = raw.get("user")
        if not isinstance(user, dict) or not user.get("id"):
            return None
        return {
            "apiUrl": raw["apiUrl"],
            "token": raw["token"],
            "user": {
                "id": user["id"],
                "email": user.get("email", ""),
                "displayName": user.get("displayName"),
            },
            "expiresAt": raw.get("expiresAt", ""),
            "createdAt": raw.get("createdAt") or datetime.now(timezone.utc).isoformat(),
        }
    except Exception:
        return None


def clear_session(path: str = DEFAULT_PATH) -> None:
    """Remove the persisted session (logout)."""
    try:
        Path(path).unlink(missing_ok=True)
    except Exception:
        pass


def session_expired(session: dict) -> bool:
    """True when the local copy says the session has already expired."""
    try:
        t = datetime.fromisoformat(session.get("expiresAt", "").replace("Z", "+00:00")).timestamp() * 1000
    except Exception:
        return True
    return t <= datetime.now(timezone.utc).timestamp() * 1000
