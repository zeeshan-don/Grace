"""Local dev server for the GRACE API (Python port of src/api/server.ts).

    python -m grace.server.serve     → http://localhost:8787
    curl localhost:8787/api/health

Serves the exact same WSGI app (`grace.server.wsgi.wsgi_app`) that the Vercel
functions (api/*.py) are built from, so behavior is identical locally and in
production.
"""

import os
from socketserver import ThreadingMixIn
from wsgiref.simple_server import WSGIServer, make_server

from grace.config import load_env
from grace.server.wsgi import wsgi_app

DEFAULT_PORT = 8787


class ThreadingWSGIServer(ThreadingMixIn, WSGIServer):
    """Threaded WSGI server so concurrent local requests don't block (mirrors
    Node's concurrent event loop)."""
    daemon_threads = True


def main() -> None:
    load_env(os.getcwd())
    if not (os.environ.get("DATABASE_URL") or "").strip():
        # Local dev without a database: auth/usage endpoints will return 503.
        # Warn loudly instead of failing silently — DATABASE_URL is server-side
        # only (never read by the CLI), so it belongs in .env here or in the
        # Vercel project environment for deployments.
        print(
            "Warning: DATABASE_URL is not set — auth and usage endpoints will return 503. "
            "Add it to .env (local dev) or the Vercel environment (production).",
            file=os.sys.stderr,
        )
    try:
        port = int(os.environ.get("PORT") or DEFAULT_PORT)
    except (TypeError, ValueError):
        port = DEFAULT_PORT
    httpd = make_server("", port, wsgi_app, server_class=ThreadingWSGIServer)
    print(f"GRACE API listening on http://localhost:{port}  (Ctrl+C to stop)", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
