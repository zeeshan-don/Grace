"""In-process WSGI test client for the backend.

Drives `grace.server.wsgi.wsgi_app` (or any single-route WSGI app) with a
hand-built environ and returns (status, headers, parsed body) — no sockets,
no network, deterministic.
"""

import json


class WsgiResponse:
    def __init__(self, status_line: str, headers: list, body: bytes) -> None:
        self.status_line = status_line
        self.status = int(status_line.split(" ", 1)[0])
        self.headers = {k.lower(): v for k, v in headers}
        self.body = body
        self._json = None

    @property
    def json(self):
        if self._json is None:
            self._json = json.loads(self.body.decode("utf-8")) if self.body else None
        return self._json

    @property
    def retry_after(self):
        return self.headers.get("retry-after")


def wsgi_call(app, method: str, path: str, query: str = "", headers: dict | None = None, body=None):
    """Call a WSGI app in-process. `body` may be a dict (→ JSON) or bytes.
    A query embedded in `path` (e.g. "/api/usage?limit=10") is split out."""
    headers = headers or {}
    if "?" in path and not query:
        path, _, query = path.partition("?")
    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "QUERY_STRING": query,
        "SERVER_NAME": "127.0.0.1",
        "SERVER_PORT": "80",
        "SERVER_PROTOCOL": "HTTP/1.1",
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": "http",
        "wsgi.input": None,  # set below
        "wsgi.errors": __import__("io").StringIO(),
        "wsgi.multithread": False,
        "wsgi.multiprocess": False,
        "wsgi.run_once": False,
    }
    if body is not None:
        if isinstance(body, str):
            raw = body.encode("utf-8")
            environ["CONTENT_TYPE"] = "text/plain"
        elif isinstance(body, (bytes, bytearray)):
            raw = bytes(body)
            environ["CONTENT_TYPE"] = "application/json"
        else:
            raw = json.dumps(body).encode("utf-8")
            environ["CONTENT_TYPE"] = "application/json"
        environ["CONTENT_LENGTH"] = str(len(raw))
        environ["wsgi.input"] = __import__("io").BytesIO(raw)
    else:
        environ["CONTENT_LENGTH"] = "0"
        environ["wsgi.input"] = __import__("io").BytesIO(b"")
    for name, value in headers.items():
        key = name.upper().replace("-", "_")
        if key == "CONTENT_TYPE":
            environ["CONTENT_TYPE"] = value
        elif key == "CONTENT_LENGTH":
            environ["CONTENT_LENGTH"] = value
        else:
            environ["HTTP_" + key] = value

    status_holder = []
    header_holder = []

    def start_response(status_line, response_headers, exc_info=None):
        status_holder.append(status_line)
        header_holder.extend(response_headers)

    chunks = app(environ, start_response)
    body_bytes = b"".join(chunks or [])
    return WsgiResponse(status_holder[0], header_holder, body_bytes)
