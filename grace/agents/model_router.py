"""Role-based model routing (port of src/agents/modelRouter.ts).

Every agent resolves its provider + model through this router — agents never
select providers directly. The coordinator consults it per role (through the
provider factory), and the server (/api/provider) uses the same tables to
build its provider chain.
"""

import os

MODEL_TIERS = ("fast", "coding", "reasoning", "review", "no_llm")

# Role → tier mapping (single source of truth).
ROLE_TIERS = {
    "project-scout": "fast",
    "file-picker": "fast",
    "researcher": "fast",
    "test-runner": "no_llm",
    "shell-runner": "fast",
    "git-curator": "fast",
    "browser-use": "fast",
    "thinker": "reasoning",
    "editor": "coding",
    "code-reviewer": "review",
}

# The coordinator's own planning call uses the REASONING tier.
COORDINATOR_TIER = "reasoning"

# Per-provider model tables, ordered best-first.
TIER_MODELS: dict[str, dict[str, list[str]]] = {
    "nvidia": {
        "fast": ["openai/gpt-oss-20b"],
        "coding": ["openai/gpt-oss-20b", "nvidia/llama-3.3-nemotron-super-49b-v1.5"],
        "reasoning": ["nvidia/llama-3.3-nemotron-super-49b-v1.5", "openai/gpt-oss-20b"],
        "review": ["openai/gpt-oss-20b", "nvidia/llama-3.3-nemotron-super-49b-v1.5"],
        "no_llm": [],
    },
    "groq": {
        "fast": ["openai/gpt-oss-20b", "llama-3.3-70b-versatile"],
        "coding": ["openai/gpt-oss-120b", "qwen/qwen3.6-27b", "llama-3.3-70b-versatile"],
        "reasoning": ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"],
        "review": ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
        "no_llm": [],
    },
    "deepseek": {
        "fast": ["deepseek-chat"],
        "coding": ["deepseek-chat", "deepseek-reasoner"],
        "reasoning": ["deepseek-reasoner", "deepseek-chat"],
        "review": ["deepseek-chat", "deepseek-reasoner"],
        "no_llm": [],
    },
    "gemini": {
        "fast": ["gemini-3.1-flash-lite"],
        "coding": ["gemini-3.1-flash-lite"],
        "reasoning": ["gemini-3.1-flash-lite"],
        "review": ["gemini-3.1-flash-lite"],
        "no_llm": [],
    },
    "minimax": {
        "fast": ["MiniMax-M3"],
        "coding": ["MiniMax-M3"],
        "reasoning": ["MiniMax-M3"],
        "review": ["MiniMax-M3"],
        "no_llm": [],
    },
}


def all_known_models(provider: str) -> list[str]:
    by_tier = TIER_MODELS.get(provider)
    if not by_tier:
        return []
    out: list[str] = []
    for tier in MODEL_TIERS:
        for m in by_tier.get(tier, []):
            if m not in out:
                out.append(m)
    return out


def is_known_model(provider: str, model: str) -> bool:
    return model in all_known_models(provider)


def default_provider_for_tier(tier: str) -> str:
    return "groq" if tier == "fast" else "nvidia"


def tier_for_role(role: str) -> str:
    return ROLE_TIERS.get(role, "fast")


def pick_model_for_provider(provider: str, tier: str, preferred: str | None = None) -> str:
    """Pick the concrete model for a provider + tier. The user's explicitly
    preferred model is honored ONLY for the coding tier; every other tier uses
    its own table. Never returns a model the provider does not serve."""
    model_list = TIER_MODELS.get(provider, {}).get(tier, [])
    if tier == "coding" and preferred and is_known_model(provider, preferred):
        return preferred
    return model_list[0] if model_list else (preferred or "")


def default_model_router_resolve(role: str, tier: str | None, fallback: str) -> dict:
    """DEFAULT_MODEL_ROUTER.resolve — the client-side default router."""
    resolved_tier = tier or tier_for_role(role)
    if resolved_tier == "no_llm":
        return {"provider": "none", "model": "", "role": role, "tier": resolved_tier}
    provider = os.environ.get("ZEESH_PROVIDER", "").strip() or default_provider_for_tier(resolved_tier)
    preferred = os.environ.get("ZEESH_AGENT_MODEL", "").strip() or fallback
    return {"provider": provider, "model": pick_model_for_provider(provider, resolved_tier, preferred), "role": role, "tier": resolved_tier}


# Server-side provider order per tier (the "Model Router" chain):
#   Groq → NVIDIA NIM → Gemini → MiniMax
SERVER_ROUTING_PREFERENCE = ["groq", "nvidia", "gemini", "minimax"]
FAST_ROUTING_PREFERENCE = ["groq", "nvidia", "gemini", "minimax"]


def server_routing_preference(tier: str | None = None) -> list[str]:
    override = os.environ.get("ZEESH_SERVER_ROUTING", "").strip()
    if override:
        ids = [s.strip() for s in override.split(",") if s.strip()]
        if ids:
            return ids
    return FAST_ROUTING_PREFERENCE if tier == "fast" else SERVER_ROUTING_PREFERENCE
