/**
 * Centralized pricing registry (GRACE FREE cost accounting).
 *
 * This is the SINGLE place where model prices live — nothing else in the
 * codebase may hardcode a per-token price. Prices are stored as integer
 * microdollars per 1M tokens (see src/costs/money.ts) and support:
 *
 *   - input / output / cached-input prices,
 *   - context tiers (a model can price differently by context length),
 *   - future price changes (edit this file or override via ZEESH_PRICING_JSON),
 *   - unknown models (they resolve to a conservative default so the daily
 *     cost ceiling always binds).
 *
 * Configurability: set `ZEESH_PRICING_JSON` to a JSON object keyed by
 * `"provider/model"` to override any entry, e.g.
 *
 *   ZEESH_PRICING_JSON='{"minimax/MiniMax-M3":{"input":0.35,"output":1.4,"cached":0.07}}'
 *
 * Prices here are the operator's best-known figures; provider pricing changes
 * should be applied here (or via the env override) without touching any other
 * code.
 */
import { costMicros, usdPer1MToMicros } from './money.ts';

/** One pricing tier: prices that apply while the context is ≤ maxContextTokens. */
export interface PriceTier {
  maxContextTokens: number;
  inputMicrosPer1M: number;
  outputMicrosPer1M: number;
  cachedInputMicrosPer1M: number;
}

export interface ModelPrice {
  /** Tiers ordered by ascending maxContextTokens. At least one tier. */
  tiers: PriceTier[];
}

/** Key used in the registry: `${provider}/${model}`. */
export function priceKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * Conservative default for models with no registered price. Chosen as the
 * MiniMax-M3 512K-tier price — a low-but-real floor — so an unregistered
 * model can never silently bypass the ₹20/day ceiling.
 */
const DEFAULT_UNKNOWN_PRICE: ModelPrice = {
  tiers: [
    {
      maxContextTokens: Number.MAX_SAFE_INTEGER,
      inputMicrosPer1M: usdPer1MToMicros(0.3),
      outputMicrosPer1M: usdPer1MToMicros(1.2),
      cachedInputMicrosPer1M: usdPer1MToMicros(0.06),
    },
  ],
};

/**
 * Registry defaults (microdollar-per-1M values derived from documented
 * pricing; every entry is overridable via ZEESH_PRICING_JSON).
 *
 * MiniMax-M3 (official pricing):
 *   context ≤ 512K : input $0.30 / output $1.20 / cache read $0.06 per 1M
 *   context 512K–1M: input $0.60 / output $2.40 / cache read $0.12 per 1M
 *
 * Gemini 3.1 Flash-Lite (Google AI pricing, May 2026):
 *   input $0.25 / output $1.50 / cached input $0.15 per 1M
 *
 * Groq models (documented Groq pricing) and NVIDIA/DeepSeek figures are
 * best-known approximations — treat as configurable estimates.
 */
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'minimax/MiniMax-M3': {
    tiers: [
      { maxContextTokens: 512_000, inputMicrosPer1M: usdPer1MToMicros(0.3), outputMicrosPer1M: usdPer1MToMicros(1.2), cachedInputMicrosPer1M: usdPer1MToMicros(0.06) },
      { maxContextTokens: 1_000_000, inputMicrosPer1M: usdPer1MToMicros(0.6), outputMicrosPer1M: usdPer1MToMicros(2.4), cachedInputMicrosPer1M: usdPer1MToMicros(0.12) },
    ],
  },
  'gemini/gemini-3.1-flash-lite': {
    tiers: [
      { maxContextTokens: Number.MAX_SAFE_INTEGER, inputMicrosPer1M: usdPer1MToMicros(0.25), outputMicrosPer1M: usdPer1MToMicros(1.5), cachedInputMicrosPer1M: usdPer1MToMicros(0.15) },
    ],
  },
  'groq/openai/gpt-oss-120b': {
    tiers: [{ maxContextTokens: Number.MAX_SAFE_INTEGER, inputMicrosPer1M: usdPer1MToMicros(0.25), outputMicrosPer1M: usdPer1MToMicros(1.0), cachedInputMicrosPer1M: usdPer1MToMicros(0.1) }],
  },
  'groq/openai/gpt-oss-20b': {
    tiers: [{ maxContextTokens: Number.MAX_SAFE_INTEGER, inputMicrosPer1M: usdPer1MToMicros(0.1), outputMicrosPer1M: usdPer1MToMicros(0.4), cachedInputMicrosPer1M: usdPer1MToMicros(0.04) }],
  },
  'groq/qwen/qwen3.6-27b': {
    tiers: [{ maxContextTokens: Number.MAX_SAFE_INTEGER, inputMicrosPer1M: usdPer1MToMicros(0.1), outputMicrosPer1M: usdPer1MToMicros(0.4), cachedInputMicrosPer1M: usdPer1MToMicros(0.04) }],
  },
  'groq/llama-3.3-70b-versatile': {
    tiers: [{ maxContextTokens: Number.MAX_SAFE_INTEGER, inputMicrosPer1M: usdPer1MToMicros(0.59), outputMicrosPer1M: usdPer1MToMicros(0.79), cachedInputMicrosPer1M: usdPer1MToMicros(0.59) }],
  },
  'groq/llama-3.1-8b-instant': {
    tiers: [{ maxContextTokens: Number.MAX_SAFE_INTEGER, inputMicrosPer1M: usdPer1MToMicros(0.05), outputMicrosPer1M: usdPer1MToMicros(0.08), cachedInputMicrosPer1M: usdPer1MToMicros(0.05) }],
  },
  'nvidia/openai/gpt-oss-20b': {
    tiers: [{ maxContextTokens: Number.MAX_SAFE_INTEGER, inputMicrosPer1M: usdPer1MToMicros(0.1), outputMicrosPer1M: usdPer1MToMicros(0.4), cachedInputMicrosPer1M: usdPer1MToMicros(0.04) }],
  },
  'nvidia/nvidia/llama-3.3-nemotron-super-49b-v1.5': {
    tiers: [{ maxContextTokens: Number.MAX_SAFE_INTEGER, inputMicrosPer1M: usdPer1MToMicros(0.1), outputMicrosPer1M: usdPer1MToMicros(0.4), cachedInputMicrosPer1M: usdPer1MToMicros(0.04) }],
  },
  'deepseek/deepseek-chat': {
    tiers: [{ maxContextTokens: Number.MAX_SAFE_INTEGER, inputMicrosPer1M: usdPer1MToMicros(0.27), outputMicrosPer1M: usdPer1MToMicros(1.1), cachedInputMicrosPer1M: usdPer1MToMicros(0.07) }],
  },
  'deepseek/deepseek-reasoner': {
    tiers: [{ maxContextTokens: Number.MAX_SAFE_INTEGER, inputMicrosPer1M: usdPer1MToMicros(0.55), outputMicrosPer1M: usdPer1MToMicros(2.19), cachedInputMicrosPer1M: usdPer1MToMicros(0.14) }],
  },
};

let registry: Record<string, ModelPrice> | null = null;

/** Merge the ZEESH_PRICING_JSON env override (if any) into the defaults. */
function loadRegistry(): Record<string, ModelPrice> {
  if (registry) return registry;
  const merged: Record<string, ModelPrice> = { ...DEFAULT_PRICES };
  const raw = process.env.ZEESH_PRICING_JSON?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (!value || typeof value !== 'object') continue;
        const v = value as Record<string, unknown>;
        const tiers = parseTiers(v);
        if (tiers.length > 0) merged[key] = { tiers };
      }
    } catch {
      // Invalid pricing JSON → ignore; the defaults (and the daily ceiling)
      // still apply. Never crash the server over a config typo.
    }
  }
  registry = merged;
  return registry;
}

function parseTiers(v: Record<string, unknown>): PriceTier[] {
  const out: PriceTier[] = [];
  const push = (input: unknown, output: unknown, cached: unknown, maxContextTokens = Number.MAX_SAFE_INTEGER): void => {
    out.push({
      maxContextTokens,
      inputMicrosPer1M: usdPer1MToMicros(numOr(input, NaN)),
      outputMicrosPer1M: usdPer1MToMicros(numOr(output, NaN)),
      cachedInputMicrosPer1M: usdPer1MToMicros(numOr(cached, NaN)),
    });
  };
  if (Array.isArray(v.contextTiers)) {
    for (const tier of v.contextTiers as Array<Record<string, unknown>>) {
      if (!tier || typeof tier !== 'object') continue;
      const max = numOr(tier.maxContextTokens, NaN);
      push(tier.input, tier.output, tier.cached, Number.isFinite(max) ? max : Number.MAX_SAFE_INTEGER);
    }
  }
  if (out.length === 0 && (v.input !== undefined || v.output !== undefined)) {
    push(v.input, v.output, v.cached);
  }
  return out;
}

function numOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Reset the cached registry (test hook). */
export function resetPricingRegistryForTests(): void {
  registry = null;
}

/**
 * Resolve the price for a provider/model. Never null: unknown models get the
 * conservative default so the cost ceiling always binds.
 */
export function priceForModel(provider: string, model: string): ModelPrice {
  const entry = loadRegistry()[priceKey(provider, model)];
  if (entry && entry.tiers.length > 0) return entry;
  return DEFAULT_UNKNOWN_PRICE;
}

/** Pick the tier whose maxContextTokens covers `contextTokens` (first tier otherwise). */
export function tierForContext(price: ModelPrice, contextTokens: number): PriceTier {
  if (price.tiers.length === 0) return DEFAULT_UNKNOWN_PRICE.tiers[0] as PriceTier;
  let selected = price.tiers[0] as PriceTier;
  for (const tier of price.tiers) {
    if (contextTokens <= tier.maxContextTokens) {
      selected = tier;
      break;
    }
    selected = tier;
  }
  return selected;
}

export interface TokenUsageForPricing {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * Estimated cost in microdollars for a request on a provider/model.
 * The context tier is selected from the request's total token volume.
 */
export function estimateCostMicros(
  provider: string,
  model: string,
  usage: TokenUsageForPricing,
): number {
  const price = priceForModel(provider, model);
  const contextTokens = usage.inputTokens + usage.outputTokens;
  const tier = tierForContext(price, contextTokens);
  const input = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    costMicros(input, tier.inputMicrosPer1M) +
    costMicros(usage.cachedInputTokens, tier.cachedInputMicrosPer1M) +
    costMicros(usage.outputTokens, tier.outputMicrosPer1M)
  );
}

/** Worst-case cost (microdollars) if the model emits exactly maxOutputTokens. */
export function worstCaseCostMicros(
  provider: string,
  model: string,
  inputTokens: number,
  maxOutputTokens: number,
): number {
  const price = priceForModel(provider, model);
  const contextTokens = inputTokens + maxOutputTokens;
  const tier = tierForContext(price, contextTokens);
  return costMicros(inputTokens, tier.inputMicrosPer1M) + costMicros(maxOutputTokens, tier.outputMicrosPer1M);
}

/** The output price (microdollars per 1M) for the tier covering `contextTokens`. */
export function outputMicrosPer1MFor(provider: string, model: string, contextTokens: number): number {
  const tier = tierForContext(priceForModel(provider, model), contextTokens);
  return tier.outputMicrosPer1M;
}
