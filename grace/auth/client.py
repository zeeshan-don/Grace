"""HTTP client for the GRACE backend (port of src/auth/client.ts).

The CLI talks to the backend only through this client. It never touches
GROQ_API_KEY, DATABASE_URL or any other server secret — the only credential it
sends is the user's own session token.

Every call has a timeout and maps transport/HTTP failures to `ApiError`, so
callers (e.g. the usage reporter) can degrade gracefully when the backend is
offline.
"""

import requests

DEFAULT_TIMEOUT_MS = 8000


class ApiError(Exception):
    """An HTTP or transport error from the backend. status 0 = unreachable/timeout."""

    def __init__(self, status: int, message: str, retry_after_seconds: int | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after_seconds = retry_after_seconds


class ApiClient:
    def __init__(self, base_url: str, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_ms = timeout_ms

    def register(self, email: str, password: str, display_name: str | None = None) -> dict:
        return self.request("/api/auth/register", method="POST", body={"email": email, "password": password, "display_name": display_name})

    def login(self, email: str, password: str) -> dict:
        return self.request("/api/auth/login", method="POST", body={"email": email, "password": password})

    def logout(self, token: str) -> None:
        self.request("/api/auth/logout", method="POST", token=token)

    def me(self, token: str) -> dict:
        data = self.request("/api/auth/me", method="GET", token=token)
        return data["user"]

    def report_usage(self, token: str, report: dict) -> dict:
        return self.request("/api/usage", method="POST", token=token, body=report)

    def get_usage(self, token: str) -> dict:
        return self.request("/api/usage?limit=1", method="GET", token=token)

    def get_session_status(self, token: str) -> dict:
        return self.request("/api/session/status", method="GET", token=token)

    def end_session(self, token: str) -> dict:
        return self.request("/api/session/end", method="POST", token=token)

    # -------------------------------------------------------------------------

    def request(self, path: str, method: str = "GET", token: str | None = None, body=None) -> dict:
        headers = {}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            res = requests.request(
                method,
                self.base_url + path,
                headers=headers,
                json=body if body is not None else None,
                timeout=self.timeout_ms / 1000,
            )
        except requests.exceptions.Timeout:
            raise ApiError(0, f"The request timed out. Is the backend running? (python -m grace.server.serve). Check ZEESH_API_URL if you changed it.")
        except requests.exceptions.RequestException:
            raise ApiError(0, f"Could not reach {self.base_url}. Is the backend running? (python -m grace.server.serve). Check ZEESH_API_URL if you changed it.")

        try:
            data = res.json()
        except Exception:
            data = None

        if not res.ok:
            error = data.get("error") if isinstance(data, dict) else None
            retry_after = None
            if res.status_code == 429:
                try:
                    retry_after = int(res.headers.get("retry-after") or 0) or None
                except (TypeError, ValueError):
                    retry_after = None
            raise ApiError(res.status_code, error or f"Request failed with status {res.status_code}.", retry_after)
        return data if isinstance(data, dict) else {}
