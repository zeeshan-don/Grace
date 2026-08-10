/**
 * Server-side provider layer (Milestone 10 + NVIDIA routing + role tiers).
 *
 * The production provider API keys (NVIDIA_API_KEY, GROQ_API_KEY) live here —
 * on the server — and are never sent to the CLI or the browser. Once
 * authenticated (Milestone 11) the CLI talks to this layer instead of holding
 * its own key in production. It reuses the existing provider-agnostic
 * `AIProvider` abstraction untouched (src/providers).
 *
 * Routing (the server-side Model Router, src/agents/modelRouter.ts):
 *   - coding / reasoning / review → NVIDIA primary, Groq fallback
 *   - fast tasks                  → Groq primary, NVIDIA fallback
 * The chain is wrapped in a FallbackProvider, so a failing primary (rate
 * limit, timeout, model unavailable, network, …) safely falls back to the
 * next provider at the model-request boundary — never mid-tool.
 *
 * Model availability: each provider's model is resolved against its own live
 * catalog (cached 5 min). A requested model the provider no longer serves
 * falls back to an available model for that tier instead of crashing.
 * Failures are surfaced as classified, secret-safe errors; provider keys
 * never appear in any message.
 */
import { pickModelForProvider, serverRoutingPreference, TIER_MODELS, type ModelTier } from '../agents/modelRouter.ts';
import { FallbackProvider } from '../providers/fallback.ts';
import { describeProviderError, ProviderError, statusForCategory } from '../providers/errors.ts';
import { createProvider } from '../providers/registry.ts';
import type { AIProvider, ChatMessage, ChatOptions, ChatResult, ToolDefinition } from '../providers/types.ts';
import { logApiEvent } from './log.ts';

export interface ServerProvider {
  provider: AIProvider;
}

export interface ServerProviderError {
  error: string;
}

export type ServerProviderResult = ServerProvider | ServerProviderError;

/** Server-side env var that holds the API key for each provider id. */
const PROVIDER_ENV: Record<string, string> = {
  nvidia: 'NVIDIA_API_KEY',
  groq: 'GROQ_API_KEY',
};

/**
 * Build a provider for the server using the server-side key.
 * Backward-compatible Groq-only builder (used by tests); the live path uses
 * `createServerRouter`, which routes NVIDIA → Groq.
 */
export function createServerProvider(model?: string): ServerProviderResult {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    return { error: 'Server-side GROQ_API_KEY is not configured.' };
  }
  try {
    return { provider: createProvider('groq', { apiKey, model }) };
  } catch {
    // Never surface constructor internals (could echo the key or SDK details).
    return { error: 'Could not initialize the AI provider.' };
  }
}

/**
 * Resolve the concrete model for one provider: the requested model wins when
 * it is a known model for that provider (and the coding tier), otherwise the
 * tier's default candidate is used. Never returns a model the provider does
 * not serve.
 */
export function resolveModelForProvider(providerId: string, requested: string | undefined, tier: ModelTier = 'coding'): string {
  return pickModelForProvider(providerId, tier, requested);
}

/**
 * Server-side Model Router: build the provider chain for /api/provider.
 *
 * Providers are included in preference order (per tier), each only when its
 * server-side key is configured:
 *
 *   coding/reasoning/review → NVIDIA (primary) → Groq (fallback)
 *   fast                    → Groq (primary)  → NVIDIA (fallback)
 *
 * With a single key the chain is that one provider (Groq-only deployments
 * behave exactly as before). With none, the API refuses with a clear error.
 */
export function createServerRouter(model?: string, tier?: ModelTier, perProviderModels?: Record<string, string>): ServerProviderResult {
  const chain: AIProvider[] = [];
  for (const providerId of serverRoutingPreference(tier)) {
    const envName = PROVIDER_ENV[providerId];
    const apiKey = envName ? process.env[envName]?.trim() : undefined;
    if (!apiKey) continue;
    const providerModel = perProviderModels?.[providerId] ?? resolveModelForProvider(providerId, model, tier);
    chain.push(createProvider(providerId, { apiKey, model: providerModel }));
  }
  if (chain.length === 0) {
    return { error: 'No server-side AI provider key is configured (set NVIDIA_API_KEY and/or GROQ_API_KEY).' };
  }
  try {
    return { provider: chain.length === 1 ? (chain[0] as AIProvider) : new FallbackProvider(chain) };
  } catch {
    return { error: 'Could not initialize the AI providers.' };
  }
}

// ---------------------------------------------------------------------------
// Live model catalogs (availability verification)
// ---------------------------------------------------------------------------

const MODEL_CATALOG_TTL_MS = 5 * 60_000;
const modelCatalogCache = new Map<string, { at: number; models: string[] }>();

/** Best-effort list of models a provider actually serves (cached, secret-safe). */
export async function providerModelCatalog(providerId: string): Promise<string[]> {
  const envName = PROVIDER_ENV[providerId];
  const apiKey = envName ? process.env[envName]?.trim() : undefined;
  if (!apiKey) return [];
  const cached = modelCatalogCache.get(providerId);
  if (cached && Date.now() - cached.at < MODEL_CATALOG_TTL_MS) return cached.models;
  try {
    const provider = createProvider(providerId, { apiKey });
    const models = await provider.listModels();
    modelCatalogCache.set(providerId, { at: Date.now(), models });
    return models;
  } catch {
    modelCatalogCache.set(providerId, { at: Date.now(), models: [] });
    return [];
  }
}

/**
 * Verify a requested model against the provider's live catalog and fall back
 * to an available model for the tier when it is no longer served — the
 * "configured NVIDIA model unavailable → use an available NVIDIA model" rule.
 * When the catalog is unreachable, the static tier tables still apply.
 */
function pickAvailableModel(providerId: string, requested: string | undefined, tier: ModelTier, catalog: string[]): string {
  const fallback = resolveModelForProvider(providerId, requested, tier);
  if (catalog.length === 0 || catalog.includes(fallback)) return fallback;
  const candidates = TIER_MODELS[providerId]?.[tier] ?? [];
  const hit = candidates.find((m) => catalog.includes(m));
  return hit ?? (catalog[0] as string) ?? fallback;
}

/** Resolve per-provider models for the router, verifying against live catalogs. */
export async function resolveRouterModels(model: string | undefined, tier?: ModelTier): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!tier) return out; // legacy requests (no tier) keep the old single-model path
  for (const providerId of serverRoutingPreference(tier)) {
    const catalog = await providerModelCatalog(providerId);
    out[providerId] = pickAvailableModel(providerId, model, tier, catalog);
  }
  return out;
}

/** Secret-free summary of the server router config (used by /api/session/status). */
export function describeServerRouter(): { providers: string[]; primary: string; model: string } {
  const providers = serverRoutingPreference('coding').filter((id) => {
    const envName = PROVIDER_ENV[id];
    return envName !== undefined && Boolean(process.env[envName]?.trim());
  });
  const primary = (providers[0] ?? 'none') as string;
  return { providers, primary, model: pickModelForProvider(primary, 'coding') };
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  /** Role tier hint from the client router (server-authoritative resolution). */
  tier?: ModelTier;
  temperature?: number;
  maxTokens?: number;
  /** Tool definitions forwarded to the model so agent tool calls work remotely. */
  tools?: ToolDefinition[];
}

export interface ChatOk {
  ok: true;
  result: ChatResult;
  /** Provider that actually served the request (after fallback). */
  providerId: string;
  providerLabel: string;
}

export interface ChatFail {
  ok: false;
  status: number;
  error: string;
}

export type ChatOutcome = ChatOk | ChatFail;

/**
 * Proxy a chat completion through the server-side Model Router. The caller
 * only ever sees content, tool calls, usage and the serving provider — never
 * the provider keys, and never raw provider error text (which could echo
 * credentials).
 */
export async function runServerChat(req: ChatRequest): Promise<ChatOutcome> {
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return { ok: false, status: 400, error: '"messages" must be a non-empty array.' };
  }
  // Availability-checked per-provider models (only when the client sent a
  // tier; legacy requests keep the pre-tier single-model behavior).
  const perProvider = await resolveRouterModels(req.model, req.tier);
  const created = createServerRouter(req.model, req.tier, perProvider);
  if ('error' in created) {
    return { ok: false, status: 503, error: created.error };
  }
  const opts: ChatOptions = {};
  if (req.temperature !== undefined) opts.temperature = req.temperature;
  if (req.maxTokens !== undefined) opts.maxTokens = req.maxTokens;
  if (req.tools !== undefined && req.tools.length > 0) opts.tools = req.tools;
  const startedAt = Date.now();
  try {
    const result = await created.provider.chat(req.messages, opts);
    const served = created.provider instanceof FallbackProvider ? (created.provider.lastServed ?? created.provider.primary) : created.provider;
    logApiEvent({
      method: 'POST',
      path: '/api/provider',
      status: 200,
      latencyMs: Date.now() - startedAt,
      model: req.model,
      detail: `served_by=${served?.id ?? 'unknown'}${req.tier ? ` tier=${req.tier}` : ''}`,
    });
    return { ok: true, result, providerId: served?.id ?? 'unknown', providerLabel: served?.label ?? 'AI provider' };
  } catch (err) {
    // The detailed (sanitized) reason goes to the server log for ops; the
    // client gets a categorized, key-free message so nothing sensitive ever
    // leaves the API. A router aggregate (every provider in the chain failed)
    // carries a full, scrubbed chain summary — that IS the clearest safe
    // user-facing error, so show it instead of the generic category text.
    const providerError = err instanceof ProviderError ? err : ProviderError.wrap('provider', err);
    logApiEvent({
      method: 'POST',
      path: '/api/provider',
      status: statusForCategory(providerError.category),
      latencyMs: Date.now() - startedAt,
      model: req.model,
      detail: `${providerError.category}: ${providerError.message}`,
    });
    const error = providerError.providerId === 'router' ? providerError.message : describeProviderError(providerError);
    return { ok: false, status: statusForCategory(providerError.category), error };
  }
}
