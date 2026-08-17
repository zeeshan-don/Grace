"""Client-side role routing (port of src/agents/roleRouter.ts).

Builds the per-agent provider instances for the coordinator. Every subagent
resolves its model through the router tables — agents never select providers
or models themselves.
"""

from grace.agents.model_router import (
    COORDINATOR_TIER,
    default_model_router_resolve,
    pick_model_for_provider,
)
from grace.config import groq_api_key
from grace.providers.groq import GroqProvider
from grace.providers.remote import RemoteProvider


class RoleModelRouter:
    def __init__(self, runtime) -> None:
        self.runtime = runtime

    def provider_for(self, role: str, spec) -> object | None:
        """Per-role provider — the coordinator's provider factory."""
        if spec.modelTier == "no_llm":
            return None
        return self._build(default_model_router_resolve(role, spec.modelTier, self.runtime.model))

    def planner_provider(self) -> object | None:
        """The coordinator's own planning provider (REASONING tier)."""
        return self._build(default_model_router_resolve("editor", COORDINATOR_TIER, self.runtime.model))

    def _build(self, route: dict) -> object | None:
        base = self.runtime.provider
        if isinstance(base, RemoteProvider):
            return base.with_model(route["model"], route["tier"])
        if base is not None and base.id == "groq":
            key = groq_api_key()
            if not key:
                return None
            # Only Groq is available client-side — pick a Groq model for the tier
            # (honoring the user's preferred model on the coding tier).
            return GroqProvider(api_key=key, model=pick_model_for_provider("groq", route["tier"], self.runtime.model))
        return base
