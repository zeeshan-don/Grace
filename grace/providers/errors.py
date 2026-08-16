"""
Provider error taxonomy (port of src/providers/errors.ts).

Every provider implementation throws `ProviderError` when a model request
fails, so callers can distinguish *why* it failed:

  - authentication    — the server-side API key was rejected (401/403)
  - rate_limit        — quota/TPM/RPM hit (429)
  - timeout           — the provider did not answer in time (408 / abort)
  - unavailable_model — the requested model does not exist / is not served
  - malformed_response— the provider answered with unparseable garbage
  - network           — the provider could not be reached (DNS/TLS/conn)
  - unknown           — anything else

Messages are always built from safe, static text plus scrubbed provider
detail — never raw SDK output that could echo an API key.
"""

from grace.safety import redact_secrets

PROVIDER_ERROR_CATEGORIES = (
    "authentication",
    "rate_limit",
    "quota_exhausted",
    "timeout",
    "unavailable_model",
    "server_error",
    "malformed_response",
    "network",
    "unknown",
)


class ProviderError(Exception):
    def __init__(self, provider_id: str, category: str, message: str, status: int = 0) -> None:
        super().__init__(message)
        self.providerId = provider_id
        self.category = category
        self.status = status

    @property
    def message(self) -> str:
        """The user-safe message (mirrors the TS `err.message` access)."""
        return str(self.args[0]) if self.args else ""

    @staticmethod
    def wrap(provider_id: str, err: Exception, fallback: str = "The AI provider request failed.") -> "ProviderError":
        """Wrap an arbitrary thrown value into a ProviderError (sanitized, 'unknown')."""
        if isinstance(err, ProviderError):
            return err
        raw = str(err) if isinstance(err, Exception) else str(err)
        return ProviderError(provider_id, "unknown", scrub(raw) or fallback)


def scrub(text: str) -> str:
    """Scrub free provider text (could echo credentials) before it is stored/shown."""
    return redact_secrets(text)[:400].strip()


def describe_category(category: str) -> str:
    return {
        "authentication": "authentication failed",
        "rate_limit": "rate limit hit",
        "quota_exhausted": "quota exhausted",
        "timeout": "timed out",
        "unavailable_model": "model unavailable",
        "server_error": "provider outage",
        "malformed_response": "malformed response",
        "network": "network failure",
    }.get(category, "request failed")


def is_fallback_eligible(category: str) -> bool:
    """Provider-level failures that should activate the fallback router.

    These are the ONLY categories that may switch providers: genuine
    provider-level problems. Task/model/tool failures never surface as a
    `ProviderError` from the provider boundary, so they can never trigger
    fallback.
    """
    return category in (
        "rate_limit",
        "quota_exhausted",
        "timeout",
        "unavailable_model",
        "server_error",
        "malformed_response",
        "network",
        "authentication",
        "unknown",
    )


def describe_provider_error(err: ProviderError) -> str:
    return {
        "authentication": "The AI provider rejected the server-side API key (authentication failed).",
        "rate_limit": "The AI provider rate limit was hit — wait a moment and retry.",
        "quota_exhausted": "The AI provider quota is exhausted for this account — the router tries the next provider automatically.",
        "timeout": "The AI provider request timed out — retry.",
        "unavailable_model": "The requested model is unavailable on the AI provider — pick a different model with /model.",
        "server_error": "The AI provider is experiencing an outage — the router tries the next provider automatically.",
        "malformed_response": "The AI provider returned a malformed response — retry.",
        "network": "Could not reach the AI provider (network failure) — check connectivity and retry.",
    }.get(err.category, "The AI provider request failed.")


def status_for_category(category: str) -> int:
    if category in ("rate_limit", "quota_exhausted"):
        return 429
    if category == "timeout":
        return 504
    return 502
