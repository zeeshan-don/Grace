"""Legacy sys.path bootstrap for the Vercel Python functions (api/*.py).

Kept for local/script use (e.g. `python api/provider.py`). The deployed
entrypoints no longer import this module: Vercel's Python runtime loads
api/*.py from their file path with only the repo root (and site-packages) on
sys.path, so `import _boot` crashed every endpoint at invocation with
FUNCTION_INVOCATION_FAILED. Each entrypoint now bootstraps sys.path itself
(api/*.py — see the inline comment), so nothing imports this file.

If this module IS imported, add both its own directory (api/) and the repo
root to sys.path so `grace.*` resolves.
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = _HERE
while _ROOT and not os.path.isdir(os.path.join(_ROOT, "grace")):
    _ROOT = os.path.dirname(_ROOT)
for _P in (_HERE, _ROOT):
    if _P and _P not in sys.path:
        sys.path.insert(0, _P)
