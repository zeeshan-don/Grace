"""Vercel zero-config Python function → GET /api/health.

Thin wrapper: the local dev server runs the same handler (grace/server/handlers.py).
`with_http` adds CORS, safe error responses and request logging — identical
behavior locally and in production.
"""

import _boot  # noqa: F401  (ensures the repo root is importable)

from grace.server.handlers import health_handler
from grace.server.middleware import with_http
from grace.server.wsgi import wsgi_for

app = wsgi_for(with_http(health_handler))
