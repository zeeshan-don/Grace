"""Vercel zero-config Python function → POST /api/provider.

Proxies chat completions through the server-side provider layer; the provider
API key never leaves the server.
"""

import _boot  # noqa: F401

from grace.server.handlers import provider_handler
from grace.server.middleware import with_http
from grace.server.wsgi import wsgi_for

app = wsgi_for(with_http(provider_handler))
