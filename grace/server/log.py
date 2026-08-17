"""Safe server-side request logging (port of src/api/log.ts).

Logs operational facts only — never passwords, session tokens, API keys,
DATABASE_URL, request bodies, private project files or other sensitive user
data. Every free-text field passes through scrub_for_logs() (which reuses the
safety layer's redact_secrets) before reaching the console, so a misbehaving
provider error or a strange prompt can never leak a secret into the logs.
"""

import re

from grace.safety import redact_secrets

_POSTGRES_URL_RE = re.compile(r"postgres(ql)?://[^\s\"']+", re.I)
_BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9_-]{16,}\b", re.I)
_CTRL_RE = re.compile(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f]")


def scrub_for_logs(text: str) -> str:
    """Scrub free text for log output: secrets, credentialed URLs, bearer tokens."""
    cleaned = redact_secrets(text)
    cleaned = _POSTGRES_URL_RE.sub("postgres://[REDACTED]", cleaned)
    cleaned = _BEARER_RE.sub("Bearer [REDACTED]", cleaned)
    cleaned = _CTRL_RE.sub("", cleaned)
    cleaned = cleaned[:400].strip()
    return cleaned or "[empty]"


def log_api_event(evt: dict) -> None:
    """Emit one structured, secret-safe log line for an API event."""
    parts = [
        f"method={evt.get('method')}",
        f"path={evt.get('path')}",
        f"status={evt.get('status')}",
        f"latency_ms={evt.get('latencyMs', 0)}",
    ]
    if evt.get("userId"):
        parts.append(f"user_id={evt['userId']}")
    if evt.get("model"):
        parts.append(f"model={scrub_for_logs(str(evt['model']))}")
    tokens = evt.get("tokens")
    if tokens:
        parts.append(f"tokens_in={tokens.get('input')} tokens_out={tokens.get('output')}")
    if evt.get("runId") is not None:
        parts.append(f"run_id={evt['runId']}")
    if evt.get("detail"):
        parts.append(f"detail={scrub_for_logs(str(evt['detail']))}")
    # One line per event — grep-friendly for Vercel logs.
    print(f"[api] {' '.join(parts)}")
