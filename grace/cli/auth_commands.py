"""Auth CLI commands (port of src/cli/authCommands.ts): `grace login|register|logout|whoami`.

Login/register prompt for credentials (passwords are hidden), call the
backend, and persist the session token in ~/.zeesh/auth.json (0600).
Logout invalidates the session server-side and wipes the local copy.
Whoami shows the authenticated identity, validating against the server when
reachable and degrading to the cached session when offline.
"""

from datetime import datetime, timezone

from grace.auth.client import ApiClient, ApiError
from grace.auth.session import (
    clear_session,
    load_session,
    save_session,
    session_expired,
)
from grace.cli.input import prompt_hidden, prompt_text
from grace.colors import c
from grace.config import is_local_backend, zeesh_api_url


def _backend_note(api_url: str) -> str:
    if is_local_backend(api_url):
        return f"GRACE backend: {api_url} (local dev — set ZEESH_API_URL to the deployed backend for production)"
    return f"GRACE backend: {api_url}"


def _persist(result: dict, api_url: str) -> None:
    session = {
        "apiUrl": api_url,
        "token": result["token"],
        "user": {"id": result["user"]["id"], "email": result["user"]["email"], "displayName": result["user"].get("display_name")},
        "expiresAt": result["expires_at"],
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    save_session(session)


def _handle_error(err: Exception, kind: str = "login") -> int:
    if isinstance(err, ApiError):
        if err.status == 401 and kind == "login":
            print(c.yellow('Invalid email or password. No account yet? Try "grace register".'))
        elif err.status == 409 and kind == "register":
            print(c.yellow('An account with this email already exists. Try "grace login".'))
        elif err.status == 429:
            print(c.yellow(f"Too many attempts — try again in {err.retry_after_seconds or 60}s."))
        elif err.status == 403:
            print(c.yellow(err.args[0] if err.args else str(err)))
        else:
            print(c.red(str(err)))
    else:
        print(c.red(str(err)))
    return 1


def cmd_login(arg: str) -> int:
    # The backend comes from configuration ONLY (ZEESH_API_URL override, else
    # the deployed production backend). A stale stored session must never pull
    # login back to an old dev backend.
    api_url = zeesh_api_url()
    print(c.dim(_backend_note(api_url)))

    email = (arg.strip() or prompt_text(c.bold("Email: "))).strip()
    password = prompt_hidden(c.bold("Password: "))
    if not email or not password:
        print(c.yellow("Login cancelled."))
        return 1

    try:
        result = ApiClient(api_url).login(email, password)
        _persist(result, api_url)
        print(c.green(f"Logged in as {result['user']['email']}."))
        return 0
    except Exception as err:
        return _handle_error(err, "login")


def cmd_register(arg: str) -> int:
    api_url = zeesh_api_url()
    print(c.dim(_backend_note(api_url)))

    email = (arg.strip() or prompt_text(c.bold("Email: "))).strip()
    password = prompt_hidden(c.bold("Password: "))
    if len(password) < 8:
        print(c.red("Password must be at least 8 characters."))
        return 1
    confirm = prompt_hidden(c.bold("Confirm password: "))
    if password != confirm:
        print(c.red("Passwords do not match."))
        return 1

    try:
        result = ApiClient(api_url).register(email, password)
        _persist(result, api_url)
        print(c.green(f"Account created — logged in as {result['user']['email']}."))
        return 0
    except Exception as err:
        return _handle_error(err, "register")


def cmd_logout() -> int:
    session = load_session()
    if not session:
        print(c.dim("Not logged in."))
        return 0
    server_ok = True
    try:
        ApiClient(session["apiUrl"], 3000).logout(session["token"])
    except Exception:
        server_ok = False  # Backend unreachable — local logout still succeeds.
    clear_session()
    print(c.green("Logged out — local session removed." if server_ok else "Logged out locally (backend unreachable — session may still be valid there)."))
    return 0


def cmd_whoami() -> int:
    session = load_session()
    if not session:
        print(c.dim('Not logged in. Run "grace login" to connect to the GRACE backend.'))
        return 1

    print(c.bold("GRACE session"))
    print(f"  Email:     {session['user']['email']}")
    print(f"  User ID:   {session['user']['id']}")
    print(f"  Backend:   {session['apiUrl']}")
    try:
        from datetime import datetime as dt

        expires = dt.fromisoformat(session.get("expiresAt", "").replace("Z", "+00:00")).strftime("%c") if session.get("expiresAt") else "—"
    except Exception:
        expires = session.get("expiresAt") or "—"
    print(f"  Expires:   {expires}")

    if session_expired(session):
        print(c.yellow('  Status:    expired — run "grace login" again.'))
        return 1

    try:
        user = ApiClient(session["apiUrl"], 5000).me(session["token"])
        display = f" · {user['display_name']}" if user.get("display_name") else ""
        print(c.green(f"  Status:    valid{display}"))
        return 0
    except ApiError as err:
        if err.status == 401:
            clear_session()
            print(c.yellow('  Status:    invalid session — run "grace login" again.'))
            return 1
        print(c.dim("  Status:    cannot reach backend (offline) — using cached session"))
        return 0
    except Exception:
        print(c.dim("  Status:    cannot reach backend (offline) — using cached session"))
        return 0
