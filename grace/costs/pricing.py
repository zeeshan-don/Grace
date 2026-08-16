"""Centralized pricing registry (port of src/costs/pricing.ts).

This is the SINGLE place where model prices live — nothing else in the
codebase may hardcode a per-token price. Prices are stored as integer
microdollars per 1M tokens (see grace/costs/money.py) and support:

  - input / output / cached-input prices,
  - context tiers (a model can price differently by context length),
  - future price changes (edit this file or override via ZEESH_PRICING_JSON),
  - unknown models (they resolve to a conservative default so the daily cost
    ceiling always binds).

Configurability: set `ZEESH_PRICING_JSON` to a JSON object keyed by
`"provider/model"` to override any entry.
"""

import json
import os

from grace.costs.money import cost_micros, usd_per_1m_to_micros

MAX_SAFE_INTEGER = 2**53 - 1

# Conservative default for models with no registered price. Chosen as the
# MiniMax-M3 512K-tier price — a low-but-real floor — so an unregistered model
# can never silently bypass the ₹20/day ceiling.
DEFAULT_UNKNOWN_PRICE = {
    "tiers": [
        {
            "maxContextTokens": MAX_SAFE_INTEGER,
            "inputMicrosPer1M": usd_per_1m_to_micros(0.3),
            "outputMicrosPer1M": usd_per_1m_to_micros(1.2),
            "cachedInputMicrosPer1M": usd_per_1m_to_micros(0.06),
        },
    ],
}

# Registry defaults (microdollar-per-1M values derived from documented pricing;
# every entry is overridable via ZEESH_PRICING_JSON).
DEFAULT_PRICES = {
    "minimax/MiniMax-M3": {
        "tiers": [
            {"maxContextTokens": 512_000, "inputMicrosPer1M": usd_per_1m_to_micros(0.3), "outputMicrosPer1M": usd_per_1m_to_micros(1.2), "cachedInputMicrosPer1M": usd_per_1m_to_micros(0.06)},
            {"maxContextTokens": 1_000_000, "inputMicrosPer1M": usd_per_1m_to_micros(0.6), "outputMicrosPer1M": usd_per_1m_to_micros(2.4), "cachedInputMicrosPer1M": usd_per_1m_to_micros(0.12)},
        ],
    },
    "gemini/gemini-3.1-flash-lite": {
        "tiers": [
            {"maxContextTokens": MAX_SAFE_INTEGER, "inputMicrosPer1M": usd_per_1m_to_micros(0.25), "outputMicrosPer1M": usd_per_1m_to_micros(1.5), "cachedInputMicrosPer1M": usd_per_1m_to_micros(0.15)},
        ],
    },
    "groq/openai/gpt-oss-120b": {
        "tiers": [{"maxContextTokens": MAX_SAFE_INTEGER, "inputMicrosPer1M": usd_per_1m_to_micros(0.25), "outputMicrosPer1M": usd_per_1m_to_micros(1.0), "cachedInputMicrosPer1M": usd_per_1m_to_micros(0.1)}],
    },
    "groq/openai/gpt-oss-20b": {
        "tiers": [{"maxContextTokens": MAX_SAFE_INTEGER, "inputMicrosPer1M": usd_per_1m_to_micros(0.1), "outputMicrosPer1M": usd_per_1m_to_micros(0.4), "cachedInputMicrosPer1M": usd_per_1m_to_micros(0.04)}],
    },
    "groq/qwen/qwen3.6-27b": {
        "tiers": [{"maxContextTokens": MAX_SAFE_INTEGER, "inputMicrosPer1M": usd_per_1m_to_micros(0.1), "outputMicrosPer1M": usd_per_1m_to_micros(0.4), "cachedInputMicrosPer1M": usd_per_1m_to_micros(0.04)}],
    },
    "groq/llama-3.3-70b-versatile": {
        "tiers": [{"maxContextTokens": MAX_SAFE_INTEGER, "inputMicrosPer1M": usd_per_1m_to_micros(0.59), "outputMicrosPer1M": usd_per_1m_to_micros(0.79), "cachedInputMicrosPer1M": usd_per_1m_to_micros(0.59)}],
    },
    "groq/llama-3.1-8b-instant": {
        "tiers": [{"maxContextTokens": MAX_SAFE_INTEGER, "inputMicrosPer1M": usd_per_1m_to_micros(0.05), "outputMicrosPer1M": usd_per_1m_to_micros(0.08), "cachedInputMicrosPer1M": usd_per_1m_to_micros(0.05)}],
    },
    "nvidia/openai/gpt-oss-20b": {
        "tiers": [{"maxContextTokens": MAX_SAFE_INTEGER, "inputMicrosPer1M": usd_per_1m_to_micros(0.1), "outputMicrosPer1M": usd_per_1m_to_micros(0.4), "cachedInputMicrosPer1M": usd_per_1m_to_micros(0.04)}],
    },
    "nvidia/nvidia/llama-3.3-nemotron-super-49b-v1.5": {
        "tiers": [{"maxContextTokens": MAX_SAFE_INTEGER, "inputMicrosPer1M": usd_per_1m_to_micros(0.1), "outputMicrosPer1M": usd_per_1m_to_micros(0.4), "cachedInputMicrosPer1M": usd_per_1m_to_micros(0.04)}],
    },
    "deepseek/deepseek-chat": {
        "tiers": [{"maxContextTokens": MAX_SAFE_INTEGER, "inputMicrosPer1M": usd_per_1m_to_micros(0.27), "outputMicrosPer1M": usd_per_1m_to_micros(1.1), "cachedInputMicrosPer1M": usd_per_1m_to_micros(0.07)}],
    },
    "deepseek/deepseek-reasoner": {
        "tiers": [{"maxContextTokens": MAX_SAFE_INTEGER, "inputMicrosPer1M": usd_per_1m_to_micros(0.55), "outputMicrosPer1M": usd_per_1m_to_micros(2.19), "cachedInputMicrosPer1M": usd_per_1m_to_micros(0.14)}],
    },
}

_registry: dict | None = None


def price_key(provider: str, model: str) -> str:
    return f"{provider}/{model}"


def _num_or(v, fallback):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return fallback
    return n if n == n and n >= 0 else fallback  # NaN check


def _parse_tiers(v: dict) -> list[dict]:
    out: list[dict] = []
    context_tiers = v.get("contextTiers")
    if isinstance(context_tiers, list):
        for tier in context_tiers:
            if not isinstance(tier, dict):
                continue
            max_ctx = _num_or(tier.get("maxContextTokens"), float("nan"))
            max_ctx = int(max_ctx) if max_ctx == max_ctx else MAX_SAFE_INTEGER
            out.append(_tier(tier.get("input"), tier.get("output"), tier.get("cached"), max_ctx))
    if not out and (v.get("input") is not None or v.get("output") is not None):
        out.append(_tier(v.get("input"), v.get("output"), v.get("cached"), MAX_SAFE_INTEGER))
    return out


def _tier(input_price, output_price, cached_price, max_ctx):
    return {
        "maxContextTokens": max_ctx,
        "inputMicrosPer1M": usd_per_1m_to_micros(_num_or(input_price, float("nan"))),
        "outputMicrosPer1M": usd_per_1m_to_micros(_num_or(output_price, float("nan"))),
        "cachedInputMicrosPer1M": usd_per_1m_to_micros(_num_or(cached_price, float("nan"))),
    }


def load_registry() -> dict:
    """Merge the ZEESH_PRICING_JSON env override (if any) into the defaults."""
    global _registry
    if _registry is not None:
        return _registry
    merged = {k: v for k, v in DEFAULT_PRICES.items()}
    raw = (os.environ.get("ZEESH_PRICING_JSON") or "").strip()
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                for key, value in parsed.items():
                    if not isinstance(value, dict):
                        continue
                    tiers = _parse_tiers(value)
                    if tiers:
                        merged[key] = {"tiers": tiers}
        except Exception:
            # Invalid pricing JSON → ignore; the defaults (and the daily ceiling)
            # still apply. Never crash over a config typo.
            pass
    _registry = merged
    return _registry


def reset_pricing_registry_for_tests() -> None:
    """Reset the cached registry (test hook)."""
    global _registry
    _registry = None


def price_for_model(provider: str, model: str) -> dict:
    """Resolve the price for a provider/model. Never empty: unknown models get
    the conservative default so the cost ceiling always binds."""
    entry = load_registry().get(price_key(provider, model))
    if entry and entry.get("tiers"):
        return entry
    return DEFAULT_UNKNOWN_PRICE


def tier_for_context(price: dict, context_tokens: int) -> dict:
    """Pick the tier whose maxContextTokens covers `context_tokens`."""
    tiers = price.get("tiers") or DEFAULT_UNKNOWN_PRICE["tiers"]
    if not tiers:
        return DEFAULT_UNKNOWN_PRICE["tiers"][0]
    selected = tiers[0]
    for tier in tiers:
        if context_tokens <= tier["maxContextTokens"]:
            selected = tier
            break
        selected = tier
    return selected


def estimate_cost_micros(provider: str, model: str, usage: dict) -> int:
    """Estimated cost in microdollars for a request on a provider/model.
    The context tier is selected from the request's total token volume."""
    price = price_for_model(provider, model)
    input_tokens = int(usage.get("inputTokens", 0) or 0)
    cached_tokens = int(usage.get("cachedInputTokens", 0) or 0)
    output_tokens = int(usage.get("outputTokens", 0) or 0)
    context_tokens = input_tokens + output_tokens
    tier = tier_for_context(price, context_tokens)
    uncached = max(0, input_tokens - cached_tokens)
    return (
        cost_micros(uncached, tier["inputMicrosPer1M"])
        + cost_micros(cached_tokens, tier["cachedInputMicrosPer1M"])
        + cost_micros(output_tokens, tier["outputMicrosPer1M"])
    )


def worst_case_cost_micros(provider: str, model: str, input_tokens: int, max_output_tokens: int) -> int:
    """Worst-case cost (microdollars) if the model emits exactly max_output_tokens."""
    price = price_for_model(provider, model)
    context_tokens = input_tokens + max_output_tokens
    tier = tier_for_context(price, context_tokens)
    return cost_micros(input_tokens, tier["inputMicrosPer1M"]) + cost_micros(max_output_tokens, tier["outputMicrosPer1M"])


def output_micros_per_1m_for(provider: str, model: str, context_tokens: int) -> int:
    """The output price (microdollars per 1M) for the tier covering `context_tokens`."""
    tier = tier_for_context(price_for_model(provider, model), context_tokens)
    return tier["outputMicrosPer1M"]
