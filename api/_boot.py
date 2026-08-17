"""Shared bootstrapping for the Vercel Python functions (api/*.py).

Vercel bundles the repository into each function; this module ensures the
repository root is on sys.path so `grace.server.*` imports resolve. Every
entrypoint imports this module first:

    import _boot  # noqa: F401
"""

import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
