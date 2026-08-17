"""Vercel zero-config Python function → POST /api/session/end.

Explicitly ends the user's active free session (server-authoritative).
"""

import _boot  # noqa: F401

from grace.server.handlers import end_session_handler
from grace.server.middleware import with_http
from grace.server.wsgi import wsgi_for

app = wsgi_for(with_http(end_session_handler))
