"""Cost accounting tests (port of tests/costs.test.ts): integer microdollar
arithmetic and the centralized pricing registry."""

import os

import pytest

from grace.costs.money import (
    MICROS_PER_USD,
    cost_micros,
    inr_to_usd_micros,
    sub_micros,
    usd_per_1m_to_micros,
)
from grace.costs.pricing import (
    estimate_cost_micros,
    output_micros_per_1m_for,
    price_for_model,
    reset_pricing_registry_for_tests,
    tier_for_context,
    worst_case_cost_micros,
)


@pytest.fixture(autouse=True)
def clean_pricing():
    yield
    os.environ.pop("ZEESH_PRICING_JSON", None)
    reset_pricing_registry_for_tests()


# ---------------------------------------------------------------------------
# Money arithmetic
# ---------------------------------------------------------------------------


def test_usd_per_1m_to_micros():
    assert usd_per_1m_to_micros(0.3) == 300_000
    assert usd_per_1m_to_micros(1.2) == 1_200_000
    assert usd_per_1m_to_micros(0.06) == 60_000
    assert usd_per_1m_to_micros(-1) == 0
    assert usd_per_1m_to_micros(float("nan")) == 0


def test_cost_micros():
    assert cost_micros(1_000_000, 300_000) == 300_000
    assert cost_micros(1_000, 300_000) == 300
    assert cost_micros(500, 1_200_000) == 600
    assert cost_micros(1_000, 60_000) == 60
    assert cost_micros(0, 300_000) == 0
    assert cost_micros(1_000, 0) == 0


def test_inr_to_usd_micros():
    assert inr_to_usd_micros(20, 83) == 240_964
    assert inr_to_usd_micros(20) == 240_964
    assert inr_to_usd_micros(0, 83) == 0
    assert inr_to_usd_micros(10, 0) == 0


def test_sub_micros_never_negative():
    assert sub_micros(500, 300) == 200
    assert sub_micros(100, 300) == 0
    assert sub_micros(100, 0) == 100


# ---------------------------------------------------------------------------
# Pricing registry
# ---------------------------------------------------------------------------


def test_minimax_512k_tier():
    price = price_for_model("minimax", "MiniMax-M3")
    assert len(price["tiers"]) == 2
    tier = tier_for_context(price, 400_000)
    assert tier["inputMicrosPer1M"] == 300_000
    assert tier["outputMicrosPer1M"] == 1_200_000
    assert tier["cachedInputMicrosPer1M"] == 60_000


def test_minimax_1m_tier():
    price = price_for_model("minimax", "MiniMax-M3")
    tier = tier_for_context(price, 600_000)
    assert tier["inputMicrosPer1M"] == 600_000
    assert tier["outputMicrosPer1M"] == 2_400_000
    assert tier["cachedInputMicrosPer1M"] == 120_000


def test_estimate_cost_micros_tier_by_context():
    small = estimate_cost_micros("minimax", "MiniMax-M3", {"inputTokens": 400_000, "cachedInputTokens": 0, "outputTokens": 20_000})
    expected_small = cost_micros(400_000, 300_000) + cost_micros(20_000, 1_200_000)
    assert small == expected_small

    large = estimate_cost_micros("minimax", "MiniMax-M3", {"inputTokens": 700_000, "cachedInputTokens": 0, "outputTokens": 50_000})
    expected_large = cost_micros(700_000, 600_000) + cost_micros(50_000, 2_400_000)
    assert large == expected_large
    assert large > small * 1.5


def test_cached_tokens_cheaper_than_fresh():
    with_cache = estimate_cost_micros("minimax", "MiniMax-M3", {"inputTokens": 10_000, "cachedInputTokens": 10_000, "outputTokens": 0})
    without_cache = estimate_cost_micros("minimax", "MiniMax-M3", {"inputTokens": 10_000, "cachedInputTokens": 0, "outputTokens": 0})
    assert with_cache < without_cache


def test_worst_case_cost_micros():
    worst = worst_case_cost_micros("minimax", "MiniMax-M3", 10_000, 8_000)
    expected = cost_micros(10_000, 300_000) + cost_micros(8_000, 1_200_000)
    assert worst == expected


def test_unknown_model_conservative_default():
    price = price_for_model("minimax", "not-a-real-model")
    assert len(price["tiers"]) > 0
    assert price["tiers"][0]["inputMicrosPer1M"] > 0


def test_pricing_json_override():
    os.environ["ZEESH_PRICING_JSON"] = '{"minimax/MiniMax-M3":{"input":0.35,"output":1.4,"cached":0.07}}'
    price = price_for_model("minimax", "MiniMax-M3")
    assert price["tiers"][0]["inputMicrosPer1M"] == 350_000
    assert price["tiers"][0]["outputMicrosPer1M"] == 1_400_000
    assert price_for_model("gemini", "gemini-3.1-flash-lite")["tiers"][0]["inputMicrosPer1M"] == 250_000


def test_pricing_json_context_tiers():
    os.environ["ZEESH_PRICING_JSON"] = (
        '{"minimax/MiniMax-M3":{"contextTiers":['
        '{"maxContextTokens":100000,"input":0.1,"output":0.4,"cached":0.02},'
        '{"maxContextTokens":200000,"input":0.2,"output":0.8,"cached":0.04}]}}'
    )
    price = price_for_model("minimax", "MiniMax-M3")
    assert len(price["tiers"]) == 2
    assert tier_for_context(price, 50_000)["inputMicrosPer1M"] == 100_000
    assert tier_for_context(price, 150_000)["inputMicrosPer1M"] == 200_000


def test_invalid_pricing_json_falls_back():
    os.environ["ZEESH_PRICING_JSON"] = "not json {"
    assert price_for_model("minimax", "MiniMax-M3")["tiers"][0]["inputMicrosPer1M"] == 300_000
    assert output_micros_per_1m_for("minimax", "MiniMax-M3", 100) == 1_200_000


def test_all_router_legs_have_prices():
    assert price_for_model("groq", "openai/gpt-oss-120b")["tiers"][0]["outputMicrosPer1M"] > 0
    assert price_for_model("nvidia", "openai/gpt-oss-20b")["tiers"][0]["outputMicrosPer1M"] > 0
    assert price_for_model("gemini", "gemini-3.1-flash-lite")["tiers"][0]["inputMicrosPer1M"] == 250_000
    assert price_for_model("minimax", "MiniMax-M3")["tiers"][0]["outputMicrosPer1M"] > 0
    assert MICROS_PER_USD == 1_000_000
