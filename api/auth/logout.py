"""Vercel zero-config Python function → POST /api/auth/logout.

Thin wrapper: the local dev server runs the same handler (grace/server/handlers.py).
"""

import _boot  # noqa: F401

from grace.server.handlers import logout_handler
from grace.server.middleware import with_http
from grace.server.wsgi import wsgi_for

app = wsgi_for(with_http(logout_handler))
