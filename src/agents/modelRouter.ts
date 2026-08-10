import type { AgentRole, ModelTier } from './types.ts';

/**
 * Model routing (subagent coordinator + server provider router).
 *
 * All agents today run on the same provider/model the user configured, but the
 * coordinator consults a `ModelRouter` per role so cheap/strong split can be
 * wired later (e.g. file-picker → fast model, thinker → strongest model)
 * without touching agent code. No provider-specific logic lives in agents —
 * only a tier hint.
 *
 * The same abstraction drives the server: the GRACE API's `/api/provider`
 * routes each request through `SERVER_ROUTING_PREFERENCE` (NVIDIA primary,
 * Groq fallback) — see src/api/providers.ts.
 */
export interface ModelRoute {
  /** Provider id the request should be sent to (e.g. 'nvidia' | 'groq'). */
  provider: string;
  /** Concrete model id on that provider. */
  model: string;
}

export interface ModelRouter {
  /**
   * Resolve the provider + model for a role/tier. `fallback` is the runtime's
   * configured model — the default keeps every role on it.
   */
  resolve(role: AgentRole, tier: ModelTier, fallback: string): ModelRoute;
}

/**
 * Default router: every role uses the runtime's model. `ZEESH_AGENT_MODEL`
 * overrides all roles for testing/diagnostics; `ZEESH_PROVIDER` overrides the
 * provider id the same way (server operators may prefer 'nvidia').
 */
export const DEFAULT_MODEL_ROUTER: ModelRouter = {
  resolve: (_role, _tier, fallback) => ({
    provider: process.env.ZEESH_PROVIDER?.trim() || 'groq',
    model: process.env.ZEESH_AGENT_MODEL?.trim() || fallback,
  }),
};

/**
 * Server-side routing preference for the GRACE API's provider proxy (the
 * "Model Router"): providers are tried in this order, each only when its
 * server-side API key is configured. NVIDIA is primary; Groq is the automatic
 * fallback for the same request (see FallbackProvider).
 */
export const SERVER_ROUTING_PREFERENCE: readonly string[] = ['nvidia', 'groq'];
