"""Vercel zero-config Python function → GET /api/session/status.

Server-authoritative free-session state (quota, expiry, provider/model).
"""

import _boot  # noqa: F401

from grace.server.handlers import session_status_handler
from grace.server.middleware import with_http
from grace.server.wsgi import wsgi_for

app = wsgi_for(with_http(session_status_handler))
