/**
 * Role-based Model Router tests (GRACE).
 *
 * Verifies the routing policy in ONE place (src/agents/modelRouter.ts):
 *   - every role resolves to the correct tier,
 *   - every tier resolves to a valid provider/model (NVIDIA primary, Groq
 *     fast/fallback),
 *   - unavailable/unknown models never leak into a route,
 *   - the client-side role factory (RoleModelRouter) genuinely builds a
 *     different provider per role.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COORDINATOR_TIER,
  DEFAULT_MODEL_ROUTER,
  defaultProviderForTier,
  isKnownModel,
  pickModelForProvider,
  ROLE_TIERS,
  serverRoutingPreference,
  TIER_MODELS,
  tierForRole,
} from '../src/agents/modelRouter.ts';
import { RoleModelRouter } from '../src/agents/roleRouter.ts';
import { AGENT_SPECS } from '../src/agents/specs.ts';
import { GroqProvider } from '../src/providers/groq.ts';
import { RemoteProvider } from '../src/providers/remote.ts';
import type { AIProvider } from '../src/providers/types.ts';
import type { Runtime } from '../src/runtime.ts';

// ---------------------------------------------------------------------------
// Role → tier
// ---------------------------------------------------------------------------

test('every role maps to the expected tier', () => {
  assert.equal(ROLE_TIERS['project-scout'], 'fast');
  assert.equal(ROLE_TIERS['file-picker'], 'fast');
  assert.equal(ROLE_TIERS['researcher'], 'fast');
  assert.equal(ROLE_TIERS['browser-use'], 'fast');
  assert.equal(ROLE_TIERS['editor'], 'coding');
  assert.equal(ROLE_TIERS['thinker'], 'reasoning');
  assert.equal(ROLE_TIERS['code-reviewer'], 'review');
  assert.equal(ROLE_TIERS['test-runner'], 'no_llm');
  assert.equal(COORDINATOR_TIER, 'reasoning');
});

test('agent specs agree with the role tier table (single source of truth)', () => {
  for (const role of Object.keys(ROLE_TIERS) as Array<keyof typeof ROLE_TIERS>) {
    assert.equal(AGENT_SPECS[role].modelTier, ROLE_TIERS[role], `${role} spec carries its tier`);
  }
});

// ---------------------------------------------------------------------------
// Tier → provider/model
// ---------------------------------------------------------------------------

test('NVIDIA is primary for coding/reasoning/review; Groq for fast', () => {
  assert.equal(defaultProviderForTier('fast'), 'groq');
  assert.equal(defaultProviderForTier('coding'), 'nvidia');
  assert.equal(defaultProviderForTier('reasoning'), 'nvidia');
  assert.equal(defaultProviderForTier('review'), 'nvidia');
});

test('the default router resolves genuinely different routes per role', () => {
  const preferred = 'openai/gpt-oss-20b';
  const editor = DEFAULT_MODEL_ROUTER.resolve('editor', tierForRole('editor'), preferred);
  const scout = DEFAULT_MODEL_ROUTER.resolve('project-scout', tierForRole('project-scout'), preferred);
  const thinker = DEFAULT_MODEL_ROUTER.resolve('thinker', tierForRole('thinker'), preferred);
  const reviewer = DEFAULT_MODEL_ROUTER.resolve('code-reviewer', tierForRole('code-reviewer'), preferred);
  const tester = DEFAULT_MODEL_ROUTER.resolve('test-runner', tierForRole('test-runner'), preferred);

  assert.deepEqual(
    { provider: editor.provider, model: editor.model, tier: editor.tier, role: editor.role },
    { provider: 'nvidia', model: 'openai/gpt-oss-20b', tier: 'coding', role: 'editor' },
  );
  assert.deepEqual(
    { provider: scout.provider, model: scout.model, tier: scout.tier },
    { provider: 'groq', model: 'openai/gpt-oss-20b', tier: 'fast' },
  );
  assert.deepEqual(
    { provider: thinker.provider, model: thinker.model, tier: thinker.tier },
    { provider: 'nvidia', model: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', tier: 'reasoning' },
  );
  assert.deepEqual(
    { provider: reviewer.provider, model: reviewer.model, tier: reviewer.tier },
    { provider: 'nvidia', model: 'openai/gpt-oss-20b', tier: 'review' },
  );
  assert.equal(tester.tier, 'no_llm');
  assert.equal(tester.provider, 'none');
  assert.equal(tester.model, '');
});

test('pickModelForProvider never returns a model the provider does not serve', () => {
  // Unknown preferred model → the tier's own default.
  assert.equal(pickModelForProvider('nvidia', 'coding', 'not-a-real-model'), 'openai/gpt-oss-20b');
  // A known NVIDIA model is honored on the coding tier.
  assert.equal(pickModelForProvider('nvidia', 'coding', 'nvidia/llama-3.3-nemotron-super-49b-v1.5'), 'nvidia/llama-3.3-nemotron-super-49b-v1.5');
  // An NVIDIA-only model is never forced onto Groq.
  assert.equal(pickModelForProvider('groq', 'coding', 'nvidia/llama-3.3-nemotron-super-49b-v1.5'), 'openai/gpt-oss-120b');
  // A known Groq model is honored on the coding tier.
  assert.equal(pickModelForProvider('groq', 'coding', 'openai/gpt-oss-120b'), 'openai/gpt-oss-120b');
  // The user's preference never overrides the fast/reasoning/review tiers.
  assert.equal(pickModelForProvider('groq', 'fast', 'openai/gpt-oss-120b'), 'openai/gpt-oss-20b');
  assert.equal(pickModelForProvider('nvidia', 'reasoning', 'openai/gpt-oss-20b'), 'nvidia/llama-3.3-nemotron-super-49b-v1.5');
});

test('every tier resolves to a valid, known model on both providers', () => {
  for (const provider of ['nvidia', 'groq']) {
    for (const tier of ['fast', 'coding', 'reasoning', 'review'] as const) {
      const model = pickModelForProvider(provider, tier);
      assert.ok(model.length > 0, `${provider}/${tier} resolves a model`);
      assert.ok(isKnownModel(provider, model), `${model} is served by ${provider}`);
      assert.ok((TIER_MODELS[provider]?.[tier] ?? []).includes(model), `${model} is in the ${provider}/${tier} table`);
    }
  }
});

test('server routing preference is Groq → NVIDIA → Gemini → MiniMax (fast leads with Groq)', () => {
  assert.deepEqual([...serverRoutingPreference('fast')], ['groq', 'nvidia', 'gemini', 'minimax']);
  assert.deepEqual([...serverRoutingPreference('coding')], ['groq', 'nvidia', 'gemini', 'minimax']);
  assert.deepEqual([...serverRoutingPreference()], ['groq', 'nvidia', 'gemini', 'minimax']);
});

test('gemini and minimax resolve known models for every tier', () => {
  for (const provider of ['gemini', 'minimax'] as const) {
    for (const tier of ['fast', 'coding', 'reasoning', 'review'] as const) {
      const model = pickModelForProvider(provider, tier);
      assert.ok(model.length > 0, `${provider}/${tier} resolves a model`);
      assert.ok(isKnownModel(provider, model), `${model} is served by ${provider}`);
    }
  }
  // The configured defaults: Gemini Flash-Lite and MiniMax-M3.
  assert.equal(pickModelForProvider('gemini', 'coding'), 'gemini-3.1-flash-lite');
  assert.equal(pickModelForProvider('minimax', 'coding'), 'MiniMax-M3');
});

// ---------------------------------------------------------------------------
// Client-side role factory (RoleModelRouter)
// ---------------------------------------------------------------------------

function fakeRuntime(provider: AIProvider | null, model: string): Runtime {
  return {
    root: '.',
    project: {} as Runtime['project'],
    session: {} as Runtime['session'],
    undo: {} as Runtime['undo'],
    provider,
    providerError: null,
    tools: [],
    yes: false,
    ask: async () => false,
    model,
  } as unknown as Runtime;
}

test('RoleModelRouter builds a different route per role over the remote backend', () => {
  const base = new RemoteProvider({ apiUrl: 'https://zeesh-ai.vercel.app', token: 't'.repeat(64) });
  const router = new RoleModelRouter(fakeRuntime(base, 'nvidia/llama-3.3-nemotron-super-49b-v1.5'));

  const editor = router.providerFor('editor', AGENT_SPECS['editor']);
  const scout = router.providerFor('project-scout', AGENT_SPECS['project-scout']);
  const planner = router.plannerProvider();

  assert.ok(editor instanceof RemoteProvider, 'editor routes through the backend');
  assert.ok(scout instanceof RemoteProvider);
  assert.ok(planner instanceof RemoteProvider);
  assert.equal((editor as RemoteProvider).getModel().id, 'nvidia/llama-3.3-nemotron-super-49b-v1.5', 'editor → CODING');
  assert.equal((editor as RemoteProvider).modelTier, 'coding');
  assert.equal((scout as RemoteProvider).getModel().id, 'openai/gpt-oss-20b', 'scout → FAST');
  assert.equal((scout as RemoteProvider).modelTier, 'fast');
  assert.equal((planner as RemoteProvider).getModel().id, 'nvidia/llama-3.3-nemotron-super-49b-v1.5', 'coordinator planning → REASONING');
  assert.equal((planner as RemoteProvider).modelTier, 'reasoning');
  assert.notEqual(
    (editor as RemoteProvider).getModel().id,
    (scout as RemoteProvider).getModel().id,
    'the roles genuinely resolve different models',
  );
  assert.equal(router.providerFor('test-runner', AGENT_SPECS['test-runner']), null, 'NO_LLM roles get no provider');
});

test('RoleModelRouter uses Groq models for a local Groq key', () => {
  process.env.GROQ_API_KEY = 'gsk_fake';
  try {
    const base = new GroqProvider({ apiKey: 'gsk_fake', model: 'openai/gpt-oss-120b' });
    const router = new RoleModelRouter(fakeRuntime(base, 'openai/gpt-oss-120b'));
    const editor = router.providerFor('editor', AGENT_SPECS['editor']);
    const thinker = router.providerFor('thinker', AGENT_SPECS['thinker']);

    assert.ok(editor instanceof GroqProvider);
    assert.ok(thinker instanceof GroqProvider);
    assert.equal((editor as GroqProvider).getModel().id, 'openai/gpt-oss-120b', 'user preferred Groq model honored on coding');
    assert.equal((thinker as GroqProvider).getModel().id, 'llama-3.3-70b-versatile', 'reasoning uses its own Groq model');
    assert.notEqual((editor as GroqProvider).getModel().id, (thinker as GroqProvider).getModel().id);
  } finally {
    delete process.env.GROQ_API_KEY;
  }
});
