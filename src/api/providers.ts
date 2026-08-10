/**
 * Server-side provider layer (Milestone 10 + NVIDIA routing).
 *
 * The production provider API keys (NVIDIA_API_KEY, GROQ_API_KEY) live here —
 * on the server — and are never sent to the CLI or the browser. Once
 * authenticated (Milestone 11) the CLI talks to this layer instead of holding
 * its own key in production. It reuses the existing provider-agnostic
 * `AIProvider` abstraction untouched (src/providers).
 *
 * Routing: each request goes through the Model Router preference
 * (src/agents/modelRouter.ts) — NVIDIA primary, Groq fallback — wrapped in a
 * FallbackProvider so a failing primary (rate limit, timeout, model
 * unavailable, network, …) safely falls back to the next provider at the
 * model-request boundary. Failures are surfaced as classified, secret-safe
 * errors; provider keys never appear in any message.
 */
import { SERVER_ROUTING_PREFERENCE } from '../agents/modelRouter.ts';
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
 * Server-side Model Router: build the provider chain for /api/provider.
 *
 * Providers are included in `SERVER_ROUTING_PREFERENCE` order, each only when
 * its server-side key is configured, so the effective routing is:
 *
 *   NVIDIA (primary)  — when NVIDIA_API_KEY is set
 *     → Groq (fallback) — when GROQ_API_KEY is set
 *
 * With a single key the chain is that one provider (Groq-only deployments
 * behave exactly as before). With none, the API refuses with a clear error.
 */
export function createServerRouter(model?: string): ServerProviderResult {
  const chain: AIProvider[] = [];
  for (const providerId of SERVER_ROUTING_PREFERENCE) {
    const envName = PROVIDER_ENV[providerId];
    const apiKey = envName ? process.env[envName]?.trim() : undefined;
    if (!apiKey) continue;
    chain.push(createProvider(providerId, { apiKey, model }));
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

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
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
  const created = createServerRouter(req.model);
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
      detail: `served_by=${served?.id ?? 'unknown'}`,
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
