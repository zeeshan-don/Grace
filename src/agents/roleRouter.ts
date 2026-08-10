/**
 * Client-side role routing (GRACE Model Router wiring).
 *
 * Builds the per-agent provider instances for the coordinator. Every subagent
 * resolves its model through the router tables (src/agents/modelRouter.ts) —
 * agents never select providers or models themselves:
 *
 *   - logged-in/remote: one RemoteProvider per role, each carrying the role's
 *     routed model + tier; the server then routes NVIDIA → Groq with its own
 *     availability checks.
 *   - local Groq key: one GroqProvider per role with a tier-appropriate Groq
 *     model (the user's preferred model is honored for the coding tier only).
 *   - anything else (tests, custom runtimes): the runtime provider is shared.
 *
 * Roles marked `no_llm` (test-runner) return null — the coordinator runs them
 * deterministically and they never consume a model request.
 */
import { groqApiKey } from '../config/config.ts';
import { GroqProvider } from '../providers/groq.ts';
import { RemoteProvider } from '../providers/remote.ts';
import type { AIProvider } from '../providers/types.ts';
import type { Runtime } from '../runtime.ts';
import { COORDINATOR_TIER, DEFAULT_MODEL_ROUTER, pickModelForProvider, type ModelRoute } from './modelRouter.ts';
import type { AgentRole, AgentSpec, ModelTier } from './types.ts';

export class RoleModelRouter {
  private readonly runtime: Runtime;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  /** Per-role provider — the coordinator's provider factory. */
  providerFor(role: AgentRole, spec: AgentSpec): AIProvider | null {
    if (spec.modelTier === 'no_llm') return null;
    return this.build(this.resolve(role, spec.modelTier));
  }

  /** The coordinator's own planning provider (REASONING tier). */
  plannerProvider(): AIProvider | null {
    return this.build(DEFAULT_MODEL_ROUTER.resolve('editor', COORDINATOR_TIER, this.runtime.model));
  }

  private resolve(role: AgentRole, tier: ModelTier): ModelRoute {
    return DEFAULT_MODEL_ROUTER.resolve(role, tier, this.runtime.model);
  }

  private build(route: ModelRoute): AIProvider | null {
    const base = this.runtime.provider;
    if (base instanceof RemoteProvider) {
      return base.withModel(route.model, route.tier);
    }
    if (base?.id === 'groq') {
      const key = groqApiKey();
      if (!key) return null;
      // Only Groq is available client-side — pick a Groq model for the tier
      // (honoring the user's preferred model on the coding tier).
      return new GroqProvider({ apiKey: key, model: pickModelForProvider('groq', route.tier, this.runtime.model) });
    }
    return base;
  }
}
