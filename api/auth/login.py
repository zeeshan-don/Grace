"""Vercel zero-config Python function → POST /api/auth/login.

Thin wrapper: the local dev server runs the same handler (grace/server/handlers.py).
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

from grace.server.handlers import login_handler
from grace.server.middleware import with_http
from grace.server.wsgi import wsgi_for

app = wsgi_for(with_http(login_handler))
