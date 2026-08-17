"""In-memory sliding-window rate limiter (port of src/api/rateLimit.ts).

Auth endpoints (login/register) get a stricter budget per client IP than
general API calls. Limits are read from the environment so deployments and
tests can tune them without code changes:
  ZEESH_AUTH_RATE_LIMIT_MAX  (default 50 attempts / 15 min per IP)
  ZEESH_API_RATE_LIMIT_MAX   (default 300 requests / 1 min per IP)

The limiter is per-process; a shared store (Redis/Upstash) is a future
concern once multiple serverless instances exist — exactly like the TS layer.
"""

import os
import time

AUTH_WINDOW_MS = 15 * 60 * 1000
API_WINDOW_MS = 60 * 1000


class RateLimiter:
    def __init__(self, window_ms: int, max_hits: int) -> None:
        self.window_ms = window_ms
        self.max_hits = max_hits
        self.hits: dict[str, list[int]] = {}

    def check(self, key: str) -> dict:
        now = int(time.time() * 1000)
        recent = [t for t in self.hits.get(key, []) if now - t < self.window_ms]
        if len(recent) >= self.max_hits:
            self.hits[key] = recent
            oldest = recent[0] if recent else now
            retry_after = max(1, -(-(self.window_ms - (now - oldest)) // 1000))  # ceil
            return {"ok": False, "retryAfterSeconds": retry_after}
        recent.append(now)
        self.hits[key] = recent
        return {"ok": True, "retryAfterSeconds": 0}

    def reset(self) -> None:
        self.hits.clear()


_limiters: dict[str, RateLimiter] = {}


def _limiter_for(scope: str) -> RateLimiter:
    window_ms = AUTH_WINDOW_MS if scope == "auth" else API_WINDOW_MS
    env_max = os.environ.get("ZEESH_AUTH_RATE_LIMIT_MAX" if scope == "auth" else "ZEESH_API_RATE_LIMIT_MAX") or ""
    try:
        env_num = int(env_max)
        max_hits = env_num if env_num > 0 else 300
    except (TypeError, ValueError):
        max_hits = 50 if scope == "auth" else 300
    existing = _limiters.get(scope)
    if existing and existing.window_ms == window_ms and existing.max_hits == max_hits:
        return existing
    created = RateLimiter(window_ms, max_hits)
    _limiters[scope] = created
    return created


def check_rate_limit(scope: str, key: str) -> dict:
    """Check a request against the limiter for its scope."""
    return _limiter_for(scope).check(key)


def client_ip(headers: dict) -> str:
    """Best-effort client identity from proxy headers (falls back to 'local')."""
    fwd = headers.get("x-forwarded-for")
    if isinstance(fwd, str) and fwd.strip():
        return fwd.split(",")[0].strip() or "local"
    real = headers.get("x-real-ip")
    if isinstance(real, str) and real.strip():
        return real.strip()
    return "local"


def reset_rate_limiters() -> None:
    """Test hook: clear limiter state (tests also set ZEESH_*_RATE_LIMIT_MAX)."""
    for limiter in _limiters.values():
        limiter.reset()
