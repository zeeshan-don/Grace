/**
 * Cost accounting tests: integer microdollar arithmetic (src/costs/money.ts)
 * and the centralized pricing registry (src/costs/pricing.ts).
 *
 * Covers pricing correctness (#16–19 of the spec): input pricing, output
 * pricing, cache pricing, context-tier pricing, plus config-driven overrides
 * and the unknown-model conservative default.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { costMicros, inrToUsdMicros, MICROS_PER_USD, subMicros, usdPer1MToMicros } from '../src/costs/money.ts';
import {
  estimateCostMicros,
  outputMicrosPer1MFor,
  priceForModel,
  resetPricingRegistryForTests,
  tierForContext,
  worstCaseCostMicros,
} from '../src/costs/pricing.ts';

afterEach(() => {
  delete process.env.ZEESH_PRICING_JSON;
  resetPricingRegistryForTests();
});

// ---------------------------------------------------------------------------
// Money arithmetic (integers only — never floats as the stored value)
// ---------------------------------------------------------------------------

test('usdPer1MToMicros converts decimal USD prices to integer microdollars', () => {
  assert.equal(usdPer1MToMicros(0.3), 300_000);
  assert.equal(usdPer1MToMicros(1.2), 1_200_000);
  assert.equal(usdPer1MToMicros(0.06), 60_000);
  assert.equal(usdPer1MToMicros(-1), 0);
  assert.equal(usdPer1MToMicros(Number.NaN), 0);
});

test('costMicros computes exact integer costs (#16 input, #17 output, #18 cache)', () => {
  // Input at $0.30/1M → 300_000 micros/1M.
  assert.equal(costMicros(1_000_000, 300_000), 300_000, '1M tokens at $0.30 = $0.30');
  assert.equal(costMicros(1_000, 300_000), 300, '1K tokens = 300 microdollars');
  assert.equal(costMicros(500, 1_200_000), 600, '500 output tokens at $1.20/1M = 600 micros');
  assert.equal(costMicros(1_000, 60_000), 60, '1K cached tokens at $0.06/1M = 60 micros');
  assert.equal(costMicros(0, 300_000), 0);
  assert.equal(costMicros(1_000, 0), 0);
});

test('inrToUsdMicros converts the INR ceiling into USD microdollars', () => {
  // ₹20 at 83 INR/USD ≈ $0.2409638… → 240_964 microdollars (rounded to the
  // nearest integer microdollar — exact integer money, no floats).
  assert.equal(inrToUsdMicros(20, 83), 240_964);
  assert.equal(inrToUsdMicros(20), 240_964, 'default rate is 83');
  assert.equal(inrToUsdMicros(0, 83), 0);
  assert.equal(inrToUsdMicros(10, 0), 0, 'invalid rate disables the cap');
});

test('subMicros never goes below zero (reservation release)', () => {
  assert.equal(subMicros(500, 300), 200);
  assert.equal(subMicros(100, 300), 0);
  assert.equal(subMicros(100, 0), 100);
});

// ---------------------------------------------------------------------------
// Pricing registry — MiniMax-M3 context tiers
// ---------------------------------------------------------------------------

test('MiniMax-M3 pricing: 512K tier (<= 512K context) (#19)', () => {
  const price = priceForModel('minimax', 'MiniMax-M3');
  assert.equal(price.tiers.length, 2);
  const tier = tierForContext(price, 400_000);
  assert.equal(tier.inputMicrosPer1M, 300_000, 'input $0.30/1M');
  assert.equal(tier.outputMicrosPer1M, 1_200_000, 'output $1.20/1M');
  assert.equal(tier.cachedInputMicrosPer1M, 60_000, 'cache read $0.06/1M');
});

test('MiniMax-M3 pricing: 1M tier (> 512K context)', () => {
  const price = priceForModel('minimax', 'MiniMax-M3');
  const tier = tierForContext(price, 600_000);
  assert.equal(tier.inputMicrosPer1M, 600_000, 'input $0.60/1M');
  assert.equal(tier.outputMicrosPer1M, 2_400_000, 'output $2.40/1M');
  assert.equal(tier.cachedInputMicrosPer1M, 120_000, 'cache read $0.12/1M');
});

test('estimateCostMicros applies the correct tier by context volume', () => {
  // 400K input + 20K output → 512K tier.
  const small = estimateCostMicros('minimax', 'MiniMax-M3', { inputTokens: 400_000, cachedInputTokens: 0, outputTokens: 20_000 });
  const expectedSmall = costMicros(400_000, 300_000) + costMicros(20_000, 1_200_000);
  assert.equal(small, expectedSmall);

  // 700K input + 50K output → 1M tier (doubled prices).
  const large = estimateCostMicros('minimax', 'MiniMax-M3', { inputTokens: 700_000, cachedInputTokens: 0, outputTokens: 50_000 });
  const expectedLarge = costMicros(700_000, 600_000) + costMicros(50_000, 2_400_000);
  assert.equal(large, expectedLarge);
  assert.ok(large > small * 1.5, 'the 1M tier is materially more expensive');
});

test('cached input tokens are priced at the cache rate, not the input rate', () => {
  const withCache = estimateCostMicros('minimax', 'MiniMax-M3', {
    inputTokens: 10_000,
    cachedInputTokens: 10_000,
    outputTokens: 0,
  });
  const withoutCache = estimateCostMicros('minimax', 'MiniMax-M3', {
    inputTokens: 10_000,
    cachedInputTokens: 0,
    outputTokens: 0,
  });
  // 10K cached at $0.06 vs 10K fresh at $0.30 — cache is cheaper.
  assert.ok(withCache < withoutCache, 'cache reads cost less than fresh input');
});

test('worstCaseCostMicros bounds the maximum possible spend of a request', () => {
  const worst = worstCaseCostMicros('minimax', 'MiniMax-M3', 10_000, 8_000);
  const expected = costMicros(10_000, 300_000) + costMicros(8_000, 1_200_000);
  assert.equal(worst, expected);
});

// ---------------------------------------------------------------------------
// Registry configuration + unknown models
// ---------------------------------------------------------------------------

test('unknown models resolve to the conservative default so the ceiling always binds', () => {
  const price = priceForModel('minimax', 'not-a-real-model');
  assert.ok(price.tiers.length > 0);
  assert.ok(price.tiers[0]!.inputMicrosPer1M > 0, 'an unregistered model still has a non-zero price');
});

test('ZEESH_PRICING_JSON overrides a model price without touching other entries', () => {
  process.env.ZEESH_PRICING_JSON = JSON.stringify({ 'minimax/MiniMax-M3': { input: 0.35, output: 1.4, cached: 0.07 } });
  const price = priceForModel('minimax', 'MiniMax-M3');
  assert.equal(price.tiers[0]!.inputMicrosPer1M, 350_000);
  assert.equal(price.tiers[0]!.outputMicrosPer1M, 1_400_000);
  // Other models are untouched.
  assert.equal(priceForModel('gemini', 'gemini-3.1-flash-lite').tiers[0]!.inputMicrosPer1M, 250_000);
});

test('ZEESH_PRICING_JSON with context tiers overrides per-tier pricing', () => {
  process.env.ZEESH_PRICING_JSON = JSON.stringify({
    'minimax/MiniMax-M3': {
      contextTiers: [
        { maxContextTokens: 100_000, input: 0.1, output: 0.4, cached: 0.02 },
        { maxContextTokens: 200_000, input: 0.2, output: 0.8, cached: 0.04 },
      ],
    },
  });
  const price = priceForModel('minimax', 'MiniMax-M3');
  assert.equal(price.tiers.length, 2);
  assert.equal(tierForContext(price, 50_000).inputMicrosPer1M, 100_000);
  assert.equal(tierForContext(price, 150_000).inputMicrosPer1M, 200_000);
});

test('invalid ZEESH_PRICING_JSON falls back to defaults without crashing', () => {
  process.env.ZEESH_PRICING_JSON = 'not json {';
  assert.equal(priceForModel('minimax', 'MiniMax-M3').tiers[0]!.inputMicrosPer1M, 300_000);
  assert.equal(outputMicrosPer1MFor('minimax', 'MiniMax-M3', 100), 1_200_000);
});

test('registered default prices exist for every provider leg in the router chain', () => {
  // The chain (groq → nvidia → gemini → minimax) must all have prices.
  assert.ok(priceForModel('groq', 'openai/gpt-oss-120b').tiers[0]!.outputMicrosPer1M > 0);
  assert.ok(priceForModel('nvidia', 'openai/gpt-oss-20b').tiers[0]!.outputMicrosPer1M > 0);
  assert.equal(priceForModel('gemini', 'gemini-3.1-flash-lite').tiers[0]!.inputMicrosPer1M, 250_000);
  assert.ok(priceForModel('minimax', 'MiniMax-M3').tiers[0]!.outputMicrosPer1M > 0);
  assert.equal(MICROS_PER_USD, 1_000_000);
});
