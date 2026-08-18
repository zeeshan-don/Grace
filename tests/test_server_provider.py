"""Server-side provider layer tests (port of the TS provider tests).

The chain (Groq → NVIDIA → Gemini → MiniMax) is built from env-configured
keys; fallback behavior is tested with stub providers — no real API and no
keys are used.
"""

import pytest

from grace.agents.model_router import server_routing_preference
from grace.providers.errors import ProviderError
from grace.providers.fallback import FallbackProvider
from grace.providers.types import ChatResult, ModelInfo
from grace.server import providers as server_providers

MSGS = [{"role": "user", "content": "hello"}]

LABEL_MAP = {
    "groq": "Groq (LPU)",
    "nvidia": "NVIDIA NIM",
    "gemini": "Gemini",
    "minimax": "MiniMax",
}


class StubProvider:
    def __init__(self, provider_id: str, model: str | None = None, fail_category: str | None = None) -> None:
        self.id = provider_id
        self.label = LABEL_MAP.get(provider_id, provider_id)
        self.model = model or "m"
        self.fail_category = fail_category
        self.calls = 0

    def get_model(self) -> ModelInfo:
        return ModelInfo(id=self.model, contextWindow=131_072)

    def set_model(self, model_id: str) -> None:
        self.model = model_id

    def list_models(self) -> list[str]:
        return []

    def chat(self, messages, options=None) -> ChatResult:
        self.calls += 1
        if self.fail_category:
            raise ProviderError(self.id, self.fail_category, f"{self.id} failed", 429)
        return ChatResult(content=f"from {self.id}", toolCalls=[])

    def stream_chat(self, messages, options=None):
        return iter(())


def test_server_routing_preference_order():
    assert server_routing_preference("coding") == ["groq", "nvidia", "gemini", "minimax"]
    assert server_routing_preference() == ["groq", "nvidia", "gemini", "minimax"]


def test_configured_provider_chain_filters_by_keys(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "g")
    monkeypatch.setenv("NVIDIA_API_KEY", "n")
    chain = server_providers.configured_provider_chain("openai/gpt-oss-20b", "coding")
    assert [leg["provider"] for leg in chain] == ["groq", "nvidia"]
    assert chain[0]["model"] == "openai/gpt-oss-20b"
    # deepseek is not in the default server routing (it is only included when
    # explicitly added via ZEESH_SERVER_ROUTING).
    monkeypatch.setenv("DEEPSEEK_API_KEY", "d")
    chain = server_providers.configured_provider_chain(None, "coding")
    assert "deepseek" not in [leg["provider"] for leg in chain]


def test_configured_provider_chain_no_keys(monkeypatch):
    assert server_providers.configured_provider_chain(None, "coding") == []


def test_configured_provider_chain_override_routing(monkeypatch):
    monkeypatch.setenv("ZEESH_SERVER_ROUTING", "minimax,groq")
    monkeypatch.setenv("MINIMAX_API_KEY", "m")
    monkeypatch.setenv("GROQ_API_KEY", "g")
    chain = server_providers.configured_provider_chain(None, "coding")
    assert [leg["provider"] for leg in chain] == ["minimax", "groq"]
    assert chain[0]["model"] == "MiniMax-M3"


def test_create_server_router_no_keys():
    result = server_providers.create_server_router(None, "coding")
    assert "error" in result
    assert "AI provider key" in result["error"]


def test_create_server_router_single_provider(monkeypatch, capsys):
    monkeypatch.setenv("GROQ_API_KEY", "g")
    result = server_providers.create_server_router(None, "coding")
    assert "error" not in result
    assert result["provider"].id == "groq"


def test_describe_server_router(monkeypatch):
    assert server_providers.describe_server_router() == {"providers": [], "primary": "none", "model": ""}
    monkeypatch.setenv("GROQ_API_KEY", "g")
    monkeypatch.setenv("NVIDIA_API_KEY", "n")
    info = server_providers.describe_server_router()
    assert info["providers"] == ["groq", "nvidia"]
    assert info["primary"] == "groq"
    assert info["model"] == "openai/gpt-oss-120b"


def test_run_server_chat_validates_messages(monkeypatch):
    assert server_providers.run_server_chat({"messages": []})["ok"] is False
    assert server_providers.run_server_chat({})["ok"] is False


def test_run_server_chat_no_providers(monkeypatch):
    outcome = server_providers.run_server_chat({"messages": MSGS, "tier": "coding"})
    assert outcome["ok"] is False
    assert outcome["status"] == 503


def test_run_server_chat_falls_back_across_chain(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "n")
    monkeypatch.setenv("GROQ_API_KEY", "g")

    def factory(provider_id, api_key, model=None):
        stub = StubProvider(provider_id, model or "m")
        if provider_id == "nvidia":
            stub.fail_category = "rate_limit"
        return stub

    monkeypatch.setattr(server_providers, "create_provider", factory)
    outcome = server_providers.run_server_chat({"messages": MSGS, "model": "openai/gpt-oss-20b", "tier": "coding"})
    assert outcome["ok"] is True
    assert outcome["providerId"] == "groq"
    assert outcome["providerLabel"] == "Groq (LPU)"
    assert outcome["result"].content == "from groq"
    assert outcome["model"] == "openai/gpt-oss-20b"


def test_run_server_chat_aggregate_error_is_secret_safe(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "n")
    monkeypatch.setenv("GROQ_API_KEY", "g")

    def factory(provider_id, api_key, model=None):
        return StubProvider(provider_id, model or "m", fail_category="network")

    monkeypatch.setattr(server_providers, "create_provider", factory)
    outcome = server_providers.run_server_chat({"messages": MSGS, "tier": "coding"})
    assert outcome["ok"] is False
    assert outcome["status"] == 502
    assert "All AI providers failed" in outcome["error"]
    assert "nvidia failed" not in outcome["error"], "raw provider detail must stay out of the client response"


def test_run_server_chat_single_provider_error(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "g")
    monkeypatch.setattr(
        server_providers,
        "create_provider",
        lambda pid, key, model=None: StubProvider(pid, model or "m", fail_category="authentication"),
    )
    outcome = server_providers.run_server_chat({"messages": MSGS, "tier": "coding"})
    assert outcome["ok"] is False
    assert outcome["status"] == 502
    assert "authentication" in outcome["error"]


# ---------------------------------------------------------------------------
# Regression tests — multi-provider fallback
# ---------------------------------------------------------------------------


def _four_provider_factory(fail_map: dict | None = None):
    """Return a factory that creates StubProviders for groq/nvidia/gemini/minimax.

    ``fail_map`` maps provider_id → fail_category (e.g. {"groq": "rate_limit"}).
    Providers not in the map succeed.
    """
    fail_map = fail_map or {}

    def factory(provider_id, api_key, model=None):
        cat = fail_map.get(provider_id)
        return StubProvider(provider_id, model or "m", fail_category=cat)

    return factory


def _set_all_keys(monkeypatch):
    """Set all four server-side provider keys."""
    monkeypatch.setenv("GROQ_API_KEY", "g")
    monkeypatch.setenv("NVIDIA_API_KEY", "n")
    monkeypatch.setenv("GEMINI_API_KEY", "ge")
    monkeypatch.setenv("MINIMAX_API_KEY", "mi")


# Test 1 — Groq 429 → NVIDIA

def test_groq_429_falls_back_to_nvidia(monkeypatch):
    """Groq rate-limits → NVIDIA serves the request."""
    _set_all_keys(monkeypatch)
    monkeypatch.setattr(server_providers, "create_provider", _four_provider_factory({"groq": "rate_limit"}))
    outcome = server_providers.run_server_chat({"messages": MSGS, "tier": "coding"})
    assert outcome["ok"] is True
    assert outcome["providerId"] == "nvidia"
    assert outcome["result"].content == "from nvidia"


# Test 2 — Groq 429 + NVIDIA failure → Gemini

def test_groq_429_nvidia_fail_falls_back_to_gemini(monkeypatch):
    """Groq rate-limits, NVIDIA also fails → Gemini serves the request."""
    _set_all_keys(monkeypatch)
    monkeypatch.setattr(server_providers, "create_provider", _four_provider_factory({
        "groq": "rate_limit",
        "nvidia": "network",
    }))
    outcome = server_providers.run_server_chat({"messages": MSGS, "tier": "coding"})
    assert outcome["ok"] is True
    assert outcome["providerId"] == "gemini"
    assert outcome["result"].content == "from gemini"


# Test 3 — all providers fail → aggregate error

def test_all_providers_fail_shows_aggregate_error(monkeypatch):
    """Every provider in the chain fails → the final error names all providers."""
    _set_all_keys(monkeypatch)
    monkeypatch.setattr(server_providers, "create_provider", _four_provider_factory({
        "groq": "rate_limit",
        "nvidia": "network",
        "gemini": "server_error",
        "minimax": "timeout",
    }))
    outcome = server_providers.run_server_chat({"messages": MSGS, "tier": "coding"})
    assert outcome["ok"] is False
    # The status code reflects the last provider's category (timeout → 504).
    assert outcome["status"] in (502, 504)
    assert "All AI providers failed" in outcome["error"]
    # Each provider name must appear in the aggregate summary.
    for name in ("Groq", "NVIDIA NIM", "Gemini", "MiniMax"):
        assert name in outcome["error"], f"{name} missing from aggregate error"


# Test 4 — non-fallback error (authentication) → STOP

def test_groq_authentication_stops_fallback(monkeypatch):
    """Permanent authentication failure must NOT fall back to NVIDIA — it
    indicates a broken server-side key that no other provider can fix."""
    _set_all_keys(monkeypatch)
    monkeypatch.setattr(server_providers, "create_provider", _four_provider_factory({
        "groq": "authentication",
    }))
    outcome = server_providers.run_server_chat({"messages": MSGS, "tier": "coding"})
    assert outcome["ok"] is False
    assert "authentication" in outcome["error"].lower()
    # The aggregate should NOT mention other providers — they were never tried.
    assert "NVIDIA" not in outcome["error"]
    assert "Gemini" not in outcome["error"]
    assert "MiniMax" not in outcome["error"]


# Test 5 — only Groq configured → no fake fallback attempt

def test_only_groq_configured_no_fallback(monkeypatch):
    """When only Groq has a server key, a failure must not pretend to fall back
    to NVIDIA/Gemini/MiniMax — the single provider is used directly."""
    monkeypatch.setenv("GROQ_API_KEY", "g")
    monkeypatch.setattr(server_providers, "create_provider", _four_provider_factory({
        "groq": "rate_limit",
    }))
    outcome = server_providers.run_server_chat({"messages": MSGS, "tier": "coding"})
    assert outcome["ok"] is False
    # Only Groq was tried — no fake fallback to other providers.
    assert "NVIDIA" not in outcome["error"]
    assert "Gemini" not in outcome["error"]
    assert "MiniMax" not in outcome["error"]


# Test 6 — provider chain ordering

def test_provider_chain_ordering(monkeypatch):
    """The configured fallback order must be Groq → NVIDIA → Gemini → MiniMax
    for the relevant hosted routing tier."""
    _set_all_keys(monkeypatch)
    from grace.server.providers import create_server_router

    router = create_server_router(None, "coding")
    assert "error" not in router
    provider = router["provider"]
    assert isinstance(provider, FallbackProvider)
    chain_ids = [p.id for p in provider.chain]
    assert chain_ids == ["groq", "nvidia", "gemini", "minimax"], (
        f"Expected groq→nvidia→gemini→minimax, got {chain_ids}"
    )


def test_fallback_logs_warning(caplog):
    """When fallback occurs, the router must log the failure and the next
    provider so operators can diagnose chain behaviour in production."""
    import logging

    groq = StubProvider("groq", fail_category="rate_limit")
    nvidia = StubProvider("nvidia")
    router = FallbackProvider([groq, nvidia])

    with caplog.at_level(logging.WARNING, logger="grace.providers.fallback"):
        result = router.chat(MSGS)

    assert result.content == "from nvidia"
    assert "groq" in caplog.text.lower()
    assert "rate_limit" in caplog.text
    assert "nvidia" in caplog.text.lower()


def test_non_retryable_error_logs_and_stops(caplog):
    """A non-retryable error must log the reason and stop — no fallback."""
    import logging

    groq = StubProvider("groq", fail_category="authentication")
    nvidia = StubProvider("nvidia")
    router = FallbackProvider([groq, nvidia])

    with caplog.at_level(logging.WARNING, logger="grace.providers.fallback"):
        with pytest.raises(ProviderError) as exc:
            router.chat(MSGS)

    assert exc.value.category == "authentication"
    assert nvidia.calls == 0
    assert "non-retryable" in caplog.text.lower() or "stopping" in caplog.text.lower()
