"""FallbackProvider (Model Router) tests — all providers are stubbed, no real
API and no keys are used."""

import pytest

from grace.agents.model_router import server_routing_preference
from grace.providers.errors import (
    ProviderError,
    describe_category,
    is_fallback_eligible,
)
from grace.providers.fallback import FallbackProvider
from grace.providers.types import ChatMessage, ChatResult, ModelInfo

MSGS = [ChatMessage(role="user", content="hi")]


class StubProvider:
    def __init__(self, provider_id: str, chat_impl, label: str | None = None) -> None:
        self.id = provider_id
        self.label = label or (
            "NVIDIA NIM" if provider_id == "nvidia"
            else "Groq (LPU)" if provider_id == "groq"
            else "Gemini" if provider_id == "gemini"
            else "MiniMax" if provider_id == "minimax"
            else provider_id
        )
        self.chat_impl = chat_impl
        self.calls = 0

    def get_model(self) -> ModelInfo:
        return ModelInfo(id="m", contextWindow=128_000)

    def set_model(self, model_id: str) -> None:
        pass

    def list_models(self) -> list[str]:
        return [self.id]

    def chat(self, messages, options=None) -> ChatResult:
        self.calls += 1
        return self.chat_impl(messages, options)

    def stream_chat(self, messages, options=None):
        return iter(())


def ok_result(messages, options=None):
    return ChatResult(content="ok", toolCalls=[])


def test_primary_wins_when_it_succeeds():
    nvidia = StubProvider("nvidia", ok_result)
    groq = StubProvider("groq", ok_result)
    router = FallbackProvider([nvidia, groq])
    result = router.chat(MSGS)
    assert result.content == "ok"
    assert nvidia.calls == 1
    assert groq.calls == 0, "secondary must not be called when the primary succeeds"
    assert router.last_served is nvidia
    assert [a["category"] for a in router.last_attempts] == ["ok"]


def test_falls_back_on_rate_limit():
    def failing(messages, options=None):
        raise ProviderError("nvidia", "rate_limit", "rate limited", 429)

    nvidia = StubProvider("nvidia", failing)
    groq = StubProvider("groq", ok_result)
    router = FallbackProvider([nvidia, groq])
    result = router.chat(MSGS)
    assert result.content == "ok"
    assert nvidia.calls == 1
    assert groq.calls == 1
    assert router.last_served is groq
    attempts = router.last_attempts
    assert attempts[0]["providerId"] == "nvidia"
    assert attempts[0]["category"] == "rate_limit"
    assert attempts[1]["providerId"] == "groq"
    assert attempts[1]["category"] == "ok"


def test_falls_back_for_retryable_provider_error_categories():
    """All retryable categories must trigger fallback to the next provider."""
    categories = ["rate_limit", "timeout", "unavailable_model", "server_error", "malformed_response", "network", "unknown"]

    def make_failing(category):
        def failing(messages, options=None):
            raise ProviderError("nvidia", category, f"{category} failed")

        return failing

    for category in categories:
        nvidia = StubProvider("nvidia", make_failing(category))
        groq = StubProvider("groq", ok_result)
        router = FallbackProvider([nvidia, groq])
        result = router.chat(MSGS)
        assert result.content == "ok", f"primary {category} must fall back to Groq"
        assert router.last_served is groq


def test_authentication_stops_fallback():
    """Permanent authentication/configuration failures must NOT consume the
    entire chain — the router should stop at the failing provider."""
    groq = StubProvider("groq", lambda m, o=None: (_ for _ in ()).throw(
        ProviderError("groq", "authentication", "bad key", 401)
    ))
    nvidia = StubProvider("nvidia", ok_result)
    router = FallbackProvider([groq, nvidia])
    with pytest.raises(ProviderError) as exc:
        router.chat(MSGS)
    assert exc.value.category == "authentication"
    assert exc.value.providerId == "groq"
    assert nvidia.calls == 0, "NVIDIA must NOT be called after an authentication failure"
    assert router.last_served is None
    attempts = router.last_attempts
    assert len(attempts) == 1
    assert attempts[0]["category"] == "authentication"


def test_aggregates_clean_error_when_every_provider_fails():
    def nvidia_fail(messages, options=None):
        raise ProviderError("nvidia", "network", "could not reach nvidia")

    def groq_fail(messages, options=None):
        raise ProviderError("groq", "timeout", "groq timed out")

    router = FallbackProvider([StubProvider("nvidia", nvidia_fail), StubProvider("groq", groq_fail)])
    with pytest.raises(ProviderError) as exc:
        router.chat(MSGS)
    assert router.last_served is None
    message = str(exc.value)
    assert "All AI providers failed" in message
    assert "NVIDIA NIM" in message
    assert "Groq" in message
    assert "could not reach nvidia" not in message, "provider detail stays out of the user-facing summary"


def test_set_model_delegates_and_get_model_uses_primary():
    router = FallbackProvider([StubProvider("nvidia", ok_result), StubProvider("groq", ok_result)])
    router.set_model("openai/gpt-oss-20b")
    assert router.get_model().id == "m"
    assert router.list_models() == ["nvidia"]


def test_stream_buffers_through_chat():
    def nvidia_fail(messages, options=None):
        raise ProviderError("nvidia", "timeout", "timed out")

    groq = StubProvider("groq", lambda m, o=None: ChatResult(content="from groq", toolCalls=[]))
    router = FallbackProvider([StubProvider("nvidia", nvidia_fail), groq])
    events = [e.type for e in router.stream_chat(MSGS)]
    assert events == ["content", "done"]


def test_requires_at_least_two_providers():
    with pytest.raises(ValueError, match="at least two"):
        FallbackProvider([StubProvider("groq", ok_result)])


def test_describe_category_safe_labels():
    assert describe_category("rate_limit") == "rate limit hit"
    assert describe_category("quota_exhausted") == "quota exhausted"
    assert describe_category("authentication") == "authentication failed"
    assert describe_category("timeout") == "timed out"
    assert describe_category("unavailable_model") == "model unavailable"
    assert describe_category("server_error") == "provider outage"
    assert describe_category("malformed_response") == "malformed response"
    assert describe_category("network") == "network failure"
    assert describe_category("unknown") == "request failed"


def test_is_fallback_eligible_retryable_categories():
    """Retryable/transient errors must be fallback-eligible."""
    for category in [
        "rate_limit", "quota_exhausted", "timeout",
        "unavailable_model", "server_error", "malformed_response",
        "network", "unknown",
    ]:
        assert is_fallback_eligible(category), f"{category} should be fallback-eligible"


def test_is_fallback_eligible_authentication_not_eligible():
    """Authentication/configuration failures must NOT be fallback-eligible —
    they indicate a broken server-side key that no other provider can fix."""
    assert not is_fallback_eligible("authentication"), "authentication must NOT trigger fallback"


def test_server_routing_preference_order():
    assert server_routing_preference("fast") == ["groq", "nvidia", "gemini", "minimax"]
    assert server_routing_preference("coding") == ["groq", "nvidia", "gemini", "minimax"]
    assert server_routing_preference() == ["groq", "nvidia", "gemini", "minimax"]
