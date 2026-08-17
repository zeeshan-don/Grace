"""Vercel zero-config Python function → GET /api/auth/me.

Thin wrapper: the local dev server runs the same handler (grace/server/handlers.py).
"""

import _boot  # noqa: F401

from grace.server.handlers import me_handler
from grace.server.middleware import with_http
from grace.server.wsgi import wsgi_for

app = wsgi_for(with_http(me_handler))
