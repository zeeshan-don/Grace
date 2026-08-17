"""Vercel zero-config Python function → POST /api/session/end.

Explicitly ends the user's active free session (server-authoritative).
"""

import os
import sys

# Vercel's Python runtime loads api/*.py from their file path with only the
# repo root (and site-packages) on sys.path, so the old `import _boot` (whose
# module lives inside api/) crashed every endpoint at invocation with
# FUNCTION_INVOCATION_FAILED. Add this function's own directory and the repo
# root explicitly so `grace.*` resolves no matter how the module is loaded.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = _HERE
while _ROOT and not os.path.isdir(os.path.join(_ROOT, "grace")):
    _ROOT = os.path.dirname(_ROOT)
for _P in (_HERE, _ROOT):
    if _P and _P not in sys.path:
        sys.path.insert(0, _P)

from grace.server.handlers import end_session_handler
from grace.server.middleware import with_http
from grace.server.wsgi import wsgi_for

app = wsgi_for(with_http(end_session_handler))
