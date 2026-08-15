import type { AgentRole, ModelTier } from './types.ts';

export type { ModelTier } from './types.ts';

/**
 * Role-based model routing (GRACE Model Router).
 *
 * Every agent resolves its provider + model through this router — agents
 * never select providers directly. The coordinator consults it per role
 * (through the provider factory), and the server (/api/provider) uses the
 * same tables to build its provider chain.
 *
 * Tiers:
 *   - fast      cheap/quick work (scouts, pickers, researchers, browser)
 *   - coding    the editor's primary implementation model
 *   - reasoning deep strategy work (thinker, coordinator planning)
 *   - review    code review
 *   - no_llm    roles that must not consume a model request (test runner)
 *
 * Provider policy: the server chain is Groq → NVIDIA → Gemini → MiniMax
 * (see SERVER_ROUTING_PREFERENCE; fast tasks keep Groq first). The client
 * default router prefers NVIDIA for coding/reasoning/review as the
 * "user-preferred" hint; the server remains authoritative for the actual
 * chain. This is the single place where role → tier → provider → model is
 * decided.
 */

export interface ModelRoute {
  /** Provider id the request should be sent to (e.g. 'nvidia' | 'groq'). */
  provider: string;
  /** Concrete model id on that provider. */
  model: string;
  /** Role the route was resolved for ('coordinator' for the planner). */
  role: string;
  tier: ModelTier;
}

export interface ModelRouter {
  /**
   * Resolve the provider + model for a role/tier. `fallback` is the runtime's
   * configured (user-preferred) model.
   */
  resolve(role: AgentRole, tier: ModelTier, fallback: string): ModelRoute;
}

export const MODEL_TIERS: readonly ModelTier[] = ['fast', 'coding', 'reasoning', 'review', 'no_llm'];

/**
 * Role → tier mapping (single source of truth):
 *
 *   project-scout -> FAST        file-picker -> FAST
 *   researcher    -> FAST        browser     -> FAST
 *   editor        -> CODING      thinker     -> REASONING
 *   code-reviewer -> REVIEW      coordinator -> REASONING
 *   test-runner   -> NO_LLM
 */
export const ROLE_TIERS: Record<AgentRole, ModelTier> = {
  'project-scout': 'fast',
  'file-picker': 'fast',
  researcher: 'fast',
  'test-runner': 'no_llm',
  'shell-runner': 'fast',
  'git-curator': 'fast',
  'browser-use': 'fast',
  thinker: 'reasoning',
  editor: 'coding',
  'code-reviewer': 'review',
};

/** The coordinator's own planning call uses the REASONING tier. */
export const COORDINATOR_TIER: ModelTier = 'reasoning';

/**
 * Per-provider model tables, ordered best-first. Only models actually served
 * by the provider are listed. NVIDIA serves GPT-OSS 20B (fast, tool calling)
 * with Nemotron Super as a reasoning-capable alternative — the earlier
 * qwen2.5-coder / deepseek-r1 catalog entries reached end-of-life on NVIDIA
 * (HTTP 410). Groq ids are the documented Groq catalog. The server
 * additionally verifies against the live provider catalog when a model is
 * not on this list.
 */
export const TIER_MODELS: Record<string, Record<ModelTier, readonly string[]>> = {
  nvidia: {
    fast: ['openai/gpt-oss-20b'],
    coding: ['openai/gpt-oss-20b', 'nvidia/llama-3.3-nemotron-super-49b-v1.5'],
    reasoning: ['nvidia/llama-3.3-nemotron-super-49b-v1.5', 'openai/gpt-oss-20b'],
    review: ['openai/gpt-oss-20b', 'nvidia/llama-3.3-nemotron-super-49b-v1.5'],
    no_llm: [],
  },
  groq: {
    // FAST uses gpt-oss-20b: lighter/faster than the 120b coding model with
    // the same generous TPM budget — 8b-instant's free-tier TPM is too small
    // for parallel fast agents (their bursts trip the 413/TPM limit).
    fast: ['openai/gpt-oss-20b', 'llama-3.3-70b-versatile'],
    coding: ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'llama-3.3-70b-versatile'],
    reasoning: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
    review: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
    no_llm: [],
  },
  deepseek: {
    fast: ['deepseek-chat'],
    coding: ['deepseek-chat', 'deepseek-reasoner'],
    reasoning: ['deepseek-reasoner', 'deepseek-chat'],
    review: ['deepseek-chat', 'deepseek-reasoner'],
    no_llm: [],
  },
  // Gemini (Google AI). gemini-3.1-flash-lite is the configured fallback
  // model — cheap, 1M context, function calling.
  gemini: {
    fast: ['gemini-3.1-flash-lite'],
    coding: ['gemini-3.1-flash-lite'],
    reasoning: ['gemini-3.1-flash-lite'],
    review: ['gemini-3.1-flash-lite'],
    no_llm: [],
  },
  // MiniMax. MiniMax-M3 is the configured fallback model (1M context,
  // tool calling, agentic/coding SOTA).
  minimax: {
    fast: ['MiniMax-M3'],
    coding: ['MiniMax-M3'],
    reasoning: ['MiniMax-M3'],
    review: ['MiniMax-M3'],
    no_llm: [],
  },
};

/** All model ids the tables know for a provider (deduped). */
export function allKnownModels(provider: string): string[] {
  const byTier = TIER_MODELS[provider];
  if (!byTier) return [];
  return [...new Set(MODEL_TIERS.flatMap((t) => byTier[t] ?? []))];
}

/** True when `model` is a documented id for `provider`. */
export function isKnownModel(provider: string, model: string): boolean {
  return allKnownModels(provider).includes(model);
}

/** Preferred provider per tier: NVIDIA primary; Groq for fast tasks. */
export function defaultProviderForTier(tier: ModelTier): string {
  return tier === 'fast' ? 'groq' : 'nvidia';
}

/** The tier for a role (see ROLE_TIERS). */
export function tierForRole(role: AgentRole): ModelTier {
  return ROLE_TIERS[role] ?? 'fast';
}

/**
 * Pick the concrete model for a provider + tier. The user's explicitly
 * preferred model is honored ONLY for the coding tier (their primary model);
 * every other tier uses its own table so cheap/strong splits stay intact.
 * Never returns a model the provider does not serve.
 */
export function pickModelForProvider(provider: string, tier: ModelTier, preferred?: string): string {
  const list = TIER_MODELS[provider]?.[tier] ?? [];
  if (tier === 'coding' && preferred && isKnownModel(provider, preferred)) return preferred;
  return (list[0] ?? preferred ?? '');
}

/**
 * Default router. `ZEESH_AGENT_MODEL` overrides the preferred model for
 * diagnostics; `ZEESH_PROVIDER` overrides the provider id the same way.
 */
export const DEFAULT_MODEL_ROUTER: ModelRouter = {
  resolve(role, tier, fallback) {
    const resolvedTier = tier ?? tierForRole(role);
    if (resolvedTier === 'no_llm') return { provider: 'none', model: '', role, tier: resolvedTier };
    const provider = process.env.ZEESH_PROVIDER?.trim() || defaultProviderForTier(resolvedTier);
    const preferred = process.env.ZEESH_AGENT_MODEL?.trim() || fallback;
    return { provider, model: pickModelForProvider(provider, resolvedTier, preferred), role, tier: resolvedTier };
  },
};

/**
 * Server-side provider order per tier (the "Model Router" chain):
 *
 *   Groq → NVIDIA NIM → Gemini → MiniMax
 *
 * Groq leads (fast, generous free tier, LPU speed); NVIDIA NIM follows;
 * Gemini 3.1 Flash-Lite is the third rung (cheap, high volume); MiniMax-M3
 * is the final fallback. Fast tasks keep Groq first so cheap quick work does
 * not consume the higher-priced legs. Operators can reorder the chain per
 * deployment with ZEESH_SERVER_ROUTING (comma-separated provider ids).
 */
export const SERVER_ROUTING_PREFERENCE: readonly string[] = ['groq', 'nvidia', 'gemini', 'minimax'];
export const FAST_ROUTING_PREFERENCE: readonly string[] = ['groq', 'nvidia', 'gemini', 'minimax'];

/** The provider ids in the routing chain (env override ZEESH_SERVER_ROUTING). */
export function serverRoutingPreference(tier?: ModelTier): readonly string[] {
  const override = process.env.ZEESH_SERVER_ROUTING?.trim();
  if (override) {
    const ids = override.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length > 0) return ids;
  }
  return tier === 'fast' ? FAST_ROUTING_PREFERENCE : SERVER_ROUTING_PREFERENCE;
}
