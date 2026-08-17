"""WSGI adapter + shared route table (port of src/api/router.ts + server.ts).

Two entry points, one handler layer:

  - `wsgi_app` — the full router used by the LOCAL dev server
    (`python -m grace.server.serve`). Mirrors the TS node:http router.
  - `wsgi_for(handler)` — a single-route WSGI app used by the Vercel functions
    (`api/*.py`). Mirrors the TS `api/*.ts` entrypoints, which wrapped one
    handler in `withHttp`.

Both run the exact same handlers and middleware, so behavior is identical
locally and in production — the same guarantee the TS backend gave with its
shared src/api/handlers.ts.
"""

import http.client
import json
import urllib.parse
import wsgiref.util

from grace.server.handlers import (
    end_session_handler,
    health_handler,
    login_handler,
    logout_handler,
    me_handler,
    provider_handler,
    register_handler,
    session_status_handler,
    usage_handler,
)
from grace.server.log import log_api_event
from grace.server.middleware import apply_cors, with_http
from grace.server.types import HttpError

MAX_BODY_BYTES = 1_000_000

# Same route table as the TS router (src/api/router.ts).
ROUTES = [
    {"method": "GET", "pattern": "/api/health", "handler": health_handler, "allow": ["GET"]},
    {"method": "POST", "pattern": "/api/auth/register", "handler": register_handler, "allow": ["POST"]},
    {"method": "POST", "pattern": "/api/auth/login", "handler": login_handler, "allow": ["POST"]},
    {"method": "POST", "pattern": "/api/auth/logout", "handler": logout_handler, "allow": ["POST"]},
    {"method": "GET", "pattern": "/api/auth/me", "handler": me_handler, "allow": ["GET"]},
    {"method": "ANY", "pattern": "/api/usage", "handler": usage_handler, "allow": ["GET", "POST"]},
    {"method": "POST", "pattern": "/api/provider", "handler": provider_handler, "allow": ["POST"]},
    {"method": "GET", "pattern": "/api/session/status", "handler": session_status_handler, "allow": ["GET"]},
    {"method": "POST", "pattern": "/api/session/end", "handler": end_session_handler, "allow": ["POST"]},
]


def match_route(method: str, pathname: str):
    """Find a handler for a method + pathname, or None (→ 404/405)."""
    for route in ROUTES:
        if route["pattern"] != pathname:
            continue
        if route["method"] == "ANY" or route["method"] == method:
            return route["handler"]
    return None


def allowed_methods(pathname: str):
    """Allowed methods for a known path, or None when the path is unknown."""
    for route in ROUTES:
        if route["pattern"] == pathname:
            return route["allow"]
    return None


class ApiResponse:
    """The tiny `res` object handlers write to; adapts to WSGI start_response."""

    def __init__(self, start_response) -> None:
        self._start_response = start_response
        self._status = 200
        self._headers: list = []
        self._body = b""

    def status(self, code: int) -> "ApiResponse":
        self._status = code
        return self

    def set_header(self, name: str, value) -> "ApiResponse":
        self._headers.append((name, str(value)))
        return self

    def json(self, data) -> "ApiResponse":
        self._headers.append(("Content-Type", "application/json; charset=utf-8"))
        self._body = json.dumps(data).encode("utf-8")
        return self

    def send(self, text: str) -> "ApiResponse":
        self._headers.append(("Content-Type", "text/plain; charset=utf-8"))
        self._body = text.encode("utf-8")
        return self

    def finish(self):
        reason = http.client.responses.get(self._status, "OK")
        if not any(h[0].lower() == "content-length" for h in self._headers):
            self._headers.append(("Content-Length", str(len(self._body))))
        self._start_response(f"{self._status} {reason}", self._headers)
        return [self._body]


def build_request(environ: dict) -> dict:
    """Adapt a WSGI environ to the handler-layer ApiRequest shape.

    Mirrors the TS readBody/shape step: only JSON bodies are read, with a 1 MB
    cap (413) and a designed 400 for invalid JSON.
    """
    method = environ.get("REQUEST_METHOD") or "GET"
    pathname = environ.get("PATH_INFO") or "/"
    query = {}
    qs = environ.get("QUERY_STRING") or ""
    if qs:
        parsed = urllib.parse.parse_qs(qs, keep_blank_values=True)
        # Object.fromEntries(url.searchParams): duplicate keys → last value wins.
        query = {k: v[-1] for k, v in parsed.items()}

    headers = {}
    for key, value in environ.items():
        if key.startswith("HTTP_"):
            headers[key[5:].replace("_", "-").lower()] = value
    content_type = environ.get("CONTENT_TYPE") or ""
    if content_type:
        headers["content-type"] = content_type
    if environ.get("CONTENT_LENGTH") is not None:
        headers["content-length"] = environ.get("CONTENT_LENGTH")

    body = None
    if "json" in content_type.lower():
        try:
            length = int(environ.get("CONTENT_LENGTH") or 0)
        except (TypeError, ValueError):
            length = 0
        if length > MAX_BODY_BYTES:
            raise HttpError(413, "Request body too large.")
        raw = environ.get("wsgi.input").read(length) if length > 0 else b""
        if raw:
            try:
                body = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                raise HttpError(400, "Invalid JSON body.")

    return {
        "method": method,
        "url": wsgiref.util.request_uri(environ),
        "pathname": pathname,
        "query": query,
        "headers": headers,
        "body": body,
    }


def wsgi_app(environ: dict, start_response):
    """Full router WSGI app — used by the local dev server (grace/server/serve.py)."""
    res = ApiResponse(start_response)
    try:
        req = build_request(environ)
    except HttpError as err:
        apply_cors(res)
        log_api_event(
            {
                "method": environ.get("REQUEST_METHOD") or "GET",
                "path": environ.get("PATH_INFO") or "/",
                "status": err.status,
                "latencyMs": 0,
                "detail": err.message,
            }
        )
        res.status(err.status).json({"error": err.message})
        return res.finish()
    except Exception:
        apply_cors(res)
        res.status(500).json({"error": "Internal server error."})
        return res.finish()

    allow = allowed_methods(req["pathname"])
    if allow is None:
        apply_cors(res)
        res.status(404).json({"error": "Not found."})
        log_api_event({"method": req["method"], "path": req["pathname"], "status": 404, "latencyMs": 0})
        return res.finish()

    if req["method"] == "OPTIONS":
        # Preflight on a known path → 204 with CORS. This matches the deployed
        # TS backend (api/*.ts wrapped handlers in withHttp, which answers
        # OPTIONS with 204), so local behavior equals production.
        apply_cors(res)
        res.status(204).send("")
        log_api_event({"method": "OPTIONS", "path": req["pathname"], "status": 204, "latencyMs": 0})
        return res.finish()

    route = match_route(req["method"], req["pathname"])
    if route is None:
        apply_cors(res)
        res.set_header("Allow", ", ".join(allow)).status(405).json(
            {"error": f"Method not allowed. Use {', '.join(allow)}."}
        )
        log_api_event({"method": req["method"], "path": req["pathname"], "status": 405, "latencyMs": 0})
        return res.finish()

    try:
        with_http(route)(req, res)
    except HttpError as err:
        # Safety net for the request-shaping step; handler errors are already
        # contained by with_http.
        apply_cors(res)
        res.status(err.status).json({"error": err.message})
    except Exception:
        apply_cors(res)
        res.status(500).json({"error": "Internal server error."})
    return res.finish()


def wsgi_for(api_handler):
    """Single-route WSGI app for a Vercel function (mirrors api/*.ts = withHttp(handler))."""

    def app(environ: dict, start_response):
        res = ApiResponse(start_response)
        try:
            req = build_request(environ)
            with_http(api_handler)(req, res)
        except HttpError as err:
            apply_cors(res)
            res.status(err.status).json({"error": err.message})
        except Exception:
            apply_cors(res)
            res.status(500).json({"error": "Internal server error."})
        return res.finish()

    return app
