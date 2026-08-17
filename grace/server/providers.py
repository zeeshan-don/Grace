"""Server-side provider layer (port of src/api/providers.ts).

The production provider API keys (NVIDIA_API_KEY, GROQ_API_KEY, …) live here —
on the server — and are never sent to the CLI or the browser. Once
authenticated the CLI talks to this layer (/api/provider) instead of holding
its own key in production. It reuses the existing provider-agnostic
`AIProvider` abstraction untouched (grace/providers).

Routing (the server-side Model Router, grace/agents/model_router.py):
  Groq → NVIDIA NIM → Gemini → MiniMax (per tier; reorderable via
  ZEESH_SERVER_ROUTING). The chain is wrapped in a FallbackProvider, so a
  failing provider (rate limit, quota exhausted, timeout, model unavailable,
  server error, network, …) safely falls back to the next one at the
  model-request boundary — never mid-tool.

Model availability: each provider's model is resolved against its own live
catalog (cached 5 min). A requested model the provider no longer serves falls
back to an available model for that tier instead of crashing. Failures are
surfaced as classified, secret-safe errors; provider keys never appear in any
message.
"""

import os
import time

from grace.agents.model_router import pick_model_for_provider, server_routing_preference
from grace.providers.errors import ProviderError, describe_provider_error, status_for_category
from grace.providers.fallback import FallbackProvider
from grace.providers.registry import create_provider
from grace.providers.types import ChatMessage, ChatOptions, ToolDefinition, as_chat_messages

PROVIDER_ENV = {
    "groq": "GROQ_API_KEY",
    "nvidia": "NVIDIA_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "minimax": "MINIMAX_API_KEY",
}

MODEL_CATALOG_TTL_MS = 5 * 60_000
_model_catalog_cache: dict[str, dict] = {}


def configured_provider_chain(model: str | None, tier: str | None = None) -> list[dict]:
    """The provider chain that WILL be attempted for a request: preference
    order, filtered to providers with a configured server-side key, with each
    leg's resolved model. Used by the cost guard to estimate worst-case spend
    before any request is sent."""
    out: list[dict] = []
    for provider_id in server_routing_preference(tier):
        env_name = PROVIDER_ENV.get(provider_id)
        api_key = (os.environ.get(env_name) or "").strip() if env_name else ""
        if not api_key:
            continue
        out.append({"provider": provider_id, "model": resolve_model_for_provider(provider_id, model, tier or "coding")})
    return out


def create_server_provider(model: str | None = None) -> dict:
    """Backward-compatible Groq-only builder (used by tests); the live path
    uses `create_server_router`, which routes Groq → NVIDIA → Gemini → MiniMax."""
    api_key = (os.environ.get("GROQ_API_KEY") or "").strip()
    if not api_key:
        return {"error": "Server-side GROQ_API_KEY is not configured."}
    try:
        return {"provider": create_provider("groq", api_key, model)}
    except Exception:
        # Never surface constructor internals (could echo the key or SDK details).
        return {"error": "Could not initialize the AI provider."}


def resolve_model_for_provider(provider_id: str, requested: str | None, tier: str = "coding") -> str:
    """Resolve the concrete model for one provider: the requested model wins
    when it is a known model for that provider (and the coding tier), otherwise
    the tier's default candidate is used. Never returns a model the provider
    does not serve."""
    return pick_model_for_provider(provider_id, tier, requested)


def create_server_router(model: str | None = None, tier: str | None = None, per_provider_models: dict | None = None) -> dict:
    """Build the provider chain for /api/provider.

    Providers are included in preference order (per tier), each only when its
    server-side key is configured:

      Groq → NVIDIA NIM → Gemini → MiniMax   (see grace/agents/model_router.py;
      reorderable per deployment via ZEESH_SERVER_ROUTING)

    With a single key the chain is that one provider (Groq-only deployments
    behave exactly as before). With none, the API refuses with a clear error.
    """
    chain = []
    for provider_id in server_routing_preference(tier):
        env_name = PROVIDER_ENV.get(provider_id)
        api_key = (os.environ.get(env_name) or "").strip() if env_name else ""
        if not api_key:
            continue
        provider_model = (per_provider_models or {}).get(provider_id) or resolve_model_for_provider(provider_id, model, tier or "coding")
        chain.append(create_provider(provider_id, api_key, provider_model))
    if not chain:
        return {
            "error": (
                "No server-side AI provider key is configured (set GROQ_API_KEY, "
                "NVIDIA_API_KEY, GEMINI_API_KEY and/or MINIMAX_API_KEY)."
            ),
        }
    try:
        return {"provider": chain[0] if len(chain) == 1 else FallbackProvider(chain)}
    except Exception:
        return {"error": "Could not initialize the AI providers."}


# ---------------------------------------------------------------------------
# Live model catalogs (availability verification)
# ---------------------------------------------------------------------------

def provider_model_catalog(provider_id: str) -> list[str]:
    """Best-effort list of models a provider actually serves (cached, secret-safe)."""
    env_name = PROVIDER_ENV.get(provider_id)
    api_key = (os.environ.get(env_name) or "").strip() if env_name else ""
    if not api_key:
        return []
    cached = _model_catalog_cache.get(provider_id)
    if cached and time.time() * 1000 - cached["at"] < MODEL_CATALOG_TTL_MS:
        return cached["models"]
    try:
        provider = create_provider(provider_id, api_key)
        models = provider.list_models()
        _model_catalog_cache[provider_id] = {"at": time.time() * 1000, "models": models}
        return models
    except Exception:
        _model_catalog_cache[provider_id] = {"at": time.time() * 1000, "models": []}
        return []


def _pick_available_model(provider_id: str, requested: str | None, tier: str, catalog: list[str]) -> str:
    """Verify a requested model against the provider's live catalog and fall
    back to an available model for the tier when it is no longer served — the
    "configured NVIDIA model unavailable → use an available NVIDIA model" rule.
    When the catalog is unreachable, the static tier tables still apply."""
    from grace.agents.model_router import TIER_MODELS

    fallback = resolve_model_for_provider(provider_id, requested, tier)
    if not catalog or fallback in catalog:
        return fallback
    candidates = (TIER_MODELS.get(provider_id) or {}).get(tier) or []
    hit = next((m for m in candidates if m in catalog), None)
    return hit or (catalog[0] if catalog else fallback)


def resolve_router_models(model: str | None, tier: str | None = None) -> dict:
    """Resolve per-provider models for the router, verifying against live catalogs."""
    out: dict = {}
    if not tier:
        return out  # legacy requests (no tier) keep the old single-model path
    for provider_id in server_routing_preference(tier):
        catalog = provider_model_catalog(provider_id)
        out[provider_id] = _pick_available_model(provider_id, model, tier, catalog)
    return out


def describe_server_router() -> dict:
    """Secret-free summary of the server router config (used by /api/session/status)."""
    providers = [
        pid
        for pid in server_routing_preference("coding")
        if PROVIDER_ENV.get(pid) is not None and (os.environ.get(PROVIDER_ENV[pid]) or "").strip()
    ]
    primary = providers[0] if providers else "none"
    return {"providers": providers, "primary": primary, "model": pick_model_for_provider(primary, "coding")}


# ---------------------------------------------------------------------------
# Chat proxy
# ---------------------------------------------------------------------------

def _as_tool_definitions(tools) -> list[ToolDefinition]:
    out = []
    for t in tools or []:
        if isinstance(t, ToolDefinition):
            out.append(t)
        elif isinstance(t, dict):
            out.append(ToolDefinition(type=t.get("type", "function") or "function", function=t.get("function") or {}))
    return out


def run_server_chat(req: dict) -> dict:
    """Proxy a chat completion through the server-side Model Router. The caller
    only ever sees content, tool calls, usage and the serving provider — never
    the provider keys, and never raw provider error text (which could echo
    credentials)."""
    messages = req.get("messages")
    if not isinstance(messages, list) or len(messages) == 0:
        return {"ok": False, "status": 400, "error": '"messages" must be a non-empty array.'}
    # Availability-checked per-provider models (only when the client sent a
    # tier; legacy requests keep the pre-tier single-model behavior).
    per_provider = resolve_router_models(req.get("model"), req.get("tier"))
    created = create_server_router(req.get("model"), req.get("tier"), per_provider)
    if "error" in created:
        return {"ok": False, "status": 503, "error": created["error"]}
    provider = created["provider"]

    options = ChatOptions()
    if req.get("temperature") is not None:
        options.temperature = req.get("temperature")
    if req.get("maxTokens") is not None:
        options.maxTokens = req.get("maxTokens")
    tools = req.get("tools")
    if isinstance(tools, list) and len(tools) > 0:
        options.tools = _as_tool_definitions(tools)

    started_at_ms = time.time() * 1000
    try:
        result = provider.chat(as_chat_messages(messages), options)
        served = provider.last_served if isinstance(provider, FallbackProvider) and provider.last_served else (provider.primary if isinstance(provider, FallbackProvider) else provider)
        from grace.server.log import log_api_event

        detail = "served_by=" + str(getattr(served, "id", "unknown"))
        if req.get("tier"):
            detail += " tier=" + str(req.get("tier"))
        log_api_event(
            {
                "method": "POST",
                "path": "/api/provider",
                "status": 200,
                "latencyMs": int(time.time() * 1000 - started_at_ms),
                "model": req.get("model"),
                "detail": detail,
            }
        )
        served_model = served.get_model().id if served is not None and hasattr(served, "get_model") else (req.get("model") or "unknown")
        return {
            "ok": True,
            "result": result,
            "providerId": getattr(served, "id", "unknown"),
            "providerLabel": getattr(served, "label", "AI provider"),
            "model": served_model,
        }
    except Exception as err:
        # The detailed (sanitized) reason goes to the server log for ops; the
        # client gets a categorized, key-free message so nothing sensitive ever
        # leaves the API. A router aggregate (every provider in the chain
        # failed) carries a full, scrubbed chain summary — that IS the clearest
        # safe user-facing error, so show it instead of the generic text.
        from grace.server.log import log_api_event

        provider_error = err if isinstance(err, ProviderError) else ProviderError.wrap("provider", err)
        log_api_event(
            {
                "method": "POST",
                "path": "/api/provider",
                "status": status_for_category(provider_error.category),
                "latencyMs": int(time.time() * 1000 - started_at_ms),
                "model": req.get("model"),
                "detail": f"{provider_error.category}: {provider_error.message}",
            }
        )
        error = provider_error.message if provider_error.providerId == "router" else describe_provider_error(provider_error)
        return {"ok": False, "status": status_for_category(provider_error.category), "error": error}
