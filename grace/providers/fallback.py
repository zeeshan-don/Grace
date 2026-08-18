"""
FallbackProvider — the "Model Router" for a chain of providers (port of
src/providers/fallback.ts).

Tries providers in order for each model request (e.g. NVIDIA → Groq) and
returns the first successful result. The switch happens strictly at the
model-request boundary: we only move to the next provider after the current
one *threw* — no partial response was consumed, so no tool could have
executed and a fresh request to another provider cannot duplicate work.
We never retry after a response has been received.

All failure detail is kept sanitized (no API keys), and the aggregate error
names every provider that failed so the operator can see the chain state.
"""

import logging

from grace.providers.errors import (
    ProviderError,
    describe_category,
    is_fallback_eligible,
    scrub,
)
from grace.providers.types import (
    ChatMessage,
    ChatOptions,
    ChatResult,
    ModelInfo,
    StreamEvent,
)

_fallback_log = logging.getLogger("grace.providers.fallback")


class FallbackProvider:
    id = "router"
    label = "GRACE model router"

    def __init__(self, chain: list) -> None:
        if len(chain) < 2:
            raise ValueError("FallbackProvider requires at least two providers in the chain.")
        self.chain = chain
        self.serving_provider = None
        self.attempt_log: list[dict] = []

    @property
    def last_served(self):
        """The provider that served the last successful request (None after a total failure)."""
        return self.serving_provider

    @property
    def primary(self):
        return self.chain[0]

    @property
    def last_attempts(self):
        return self.attempt_log

    def get_model(self) -> ModelInfo:
        return self.chain[0].get_model()

    def set_model(self, model_id: str) -> None:
        for provider in self.chain:
            provider.set_model(model_id)

    def list_models(self) -> list[str]:
        for provider in self.chain:
            models = provider.list_models()
            if models:
                return models
        return []

    def chat(self, messages: list[ChatMessage], options: ChatOptions | None = None) -> ChatResult:
        options = options or ChatOptions()
        attempts: list[dict] = []
        last_error: ProviderError | None = None

        for provider in self.chain:
            try:
                result = provider.chat(messages, options)
                self.serving_provider = provider
                attempts.append({"providerId": provider.id, "label": provider.label, "category": "ok", "message": ""})
                self.attempt_log = attempts
                return result
            except Exception as err:
                provider_error = ProviderError.wrap(provider.id, err)
                last_error = provider_error
                attempts.append({
                    "providerId": provider.id,
                    "label": provider.label,
                    "category": provider_error.category,
                    "message": scrub(provider_error.message),
                })
                if not is_fallback_eligible(provider_error.category):
                    _fallback_log.warning(
                        "Provider %s failed with non-retryable error: %s — stopping.",
                        provider.id, provider_error.category,
                    )
                    self.serving_provider = None
                    self.attempt_log = attempts
                    raise provider_error
                # Log the fallback so operators can diagnose chain behaviour in
                # production.  The message is scrubbed — no keys or prompts.
                idx = self.chain.index(provider)
                _next = self.chain[idx + 1] if idx + 1 < len(self.chain) else None
                _fallback_log.warning(
                    "Provider %s failed: %s — falling back to %s.",
                    provider.id, provider_error.category,
                    _next.id if _next else "(none)",
                )

        self.serving_provider = None
        self.attempt_log = attempts
        raise self._aggregate(attempts, last_error)

    def stream_chat(self, messages: list[ChatMessage], options: ChatOptions | None = None):
        # Buffered stream: fallback must never happen mid-stream, so we buffer via chat.
        result = self.chat(messages, options)
        if result.content:
            yield StreamEvent(type="content", content=result.content)
        for index, tc in enumerate(result.toolCalls):
            yield StreamEvent(type="tool_call_delta", index=index, id=tc.id, name=tc.name, argumentsDelta=tc.arguments)
        yield StreamEvent(type="done", usage=result.usage)

    def _aggregate(self, attempts: list[dict], last_error: ProviderError | None) -> ProviderError:
        summary = "; ".join(
            f"{a['label']} ({describe_category(a['category'])})"
            for a in attempts
            if a["category"] != "ok"
        )
        detail = f"All AI providers failed — {summary}. Check the server-side provider configuration."
        return ProviderError(self.id, last_error.category if last_error else "unknown", detail, last_error.status if last_error else 502)
