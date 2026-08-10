import type { AgentRole, ModelTier } from './types.ts';

/**
 * Model routing (subagent coordinator).
 *
 * All agents today run on the same provider/model the user configured, but the
 * coordinator consults a `ModelRouter` per role so cheap/strong split can be
 * wired later (e.g. file-picker → fast model, thinker → strongest model)
 * without touching agent code. No provider-specific logic lives in agents —
 * only a tier hint.
 */
export interface ModelRouter {
  resolve(role: AgentRole, tier: ModelTier, fallback: string): string;
}

/**
 * Default router: every role uses the runtime's model. `ZEESH_AGENT_MODEL`
 * overrides all roles for testing/diagnostics.
 */
export const DEFAULT_MODEL_ROUTER: ModelRouter = {
  resolve: (_role, _tier, fallback) => process.env.ZEESH_AGENT_MODEL?.trim() || fallback,
};
