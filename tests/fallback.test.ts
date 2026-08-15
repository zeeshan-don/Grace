/**
 * Model Router tests: FallbackProvider (NVIDIA → Groq chain), the server-side
 * router builder (createServerRouter) and runServerChat fallback behavior.
 *
 * All providers are stubbed — no real NVIDIA/Groq API and no keys are used.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createServerRouter, resolveModelForProvider, runServerChat } from '../src/api/providers.ts';
import { serverRoutingPreference } from '../src/agents/modelRouter.ts';
import { describeCategory, isFallbackEligible, ProviderError } from '../src/providers/errors.ts';
import { FallbackProvider } from '../src/providers/fallback.ts';
import { GroqProvider } from '../src/providers/groq.ts';
import { NvidiaProvider } from '../src/providers/nvidia.ts';
import type { AIProvider, ChatMessage, ChatOptions, ChatResult, ModelInfo } from '../src/providers/types.ts';

const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];

afterEach(() => {
  // This environment carries real .env keys (loaded by src/api/server.ts);
  // every provider key must be cleared so tests stay hermetic and can never
  // hit a live provider.
  delete process.env.GROQ_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.MINIMAX_API_KEY;
  delete process.env.ZEESH_SERVER_ROUTING;
  delete process.env.ZEESH_DAILY_COST_LIMIT_INR;
  delete process.env.ZEESH_GLOBAL_DAILY_COST_LIMIT_INR;
  delete process.env.ZEESH_GLOBAL_MONTHLY_COST_LIMIT_INR;
});

/** Minimal scripted provider implementing just what the chain needs. */
class StubProvider implements AIProvider {
  readonly id: string;
  readonly label: string;
  readonly chatImpl: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResult> | ChatResult;
  calls = 0;

  constructor(id: string, chatImpl: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResult> | ChatResult) {
    this.id = id;
    this.label = id === 'nvidia' ? 'NVIDIA NIM' : 'Groq (LPU)';
    this.chatImpl = chatImpl;
  }

  getModel(): ModelInfo {
    return { id: 'm', contextWindow: 128_000, supportedFeatures: [] };
  }

  setModel(): void {}
  listModels(): Promise<string[]> {
    return Promise.resolve([this.id]);
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult> {
    this.calls += 1;
    return this.chatImpl(messages, options);
  }

  async *streamChat(): AsyncIterable<never> {
    yield* [];
  }
}

const okResult: ChatResult = { content: 'ok', toolCalls: [], finishReason: 'stop' };

// ---------------------------------------------------------------------------
// FallbackProvider
// ---------------------------------------------------------------------------

test('FallbackProvider returns the primary result when it succeeds', async () => {
  const nvidia = new StubProvider('nvidia', () => okResult);
  const groq = new StubProvider('groq', () => okResult);
  const router = new FallbackProvider([nvidia, groq]);

  const result = await router.chat(msgs);
  assert.equal(result.content, 'ok');
  assert.equal(nvidia.calls, 1);
  assert.equal(groq.calls, 0, 'secondary must not be called when the primary succeeds');
  assert.equal(router.lastServed, nvidia);
  assert.deepEqual(
    router.lastAttempts.map((a) => a.category),
    ['ok'],
  );
});

test('FallbackProvider falls back to the secondary on a provider failure', async () => {
  const nvidia = new StubProvider('nvidia', () => {
    throw new ProviderError('nvidia', 'rate_limit', 'rate limited', 429);
  });
  const groq = new StubProvider('groq', () => okResult);
  const router = new FallbackProvider([nvidia, groq]);

  const result = await router.chat(msgs);
  assert.equal(result.content, 'ok');
  assert.equal(nvidia.calls, 1);
  assert.equal(groq.calls, 1);
  assert.equal(router.lastServed, groq);
  const attempts = router.lastAttempts;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.providerId, 'nvidia');
  assert.equal(attempts[0]?.category, 'rate_limit');
  assert.equal(attempts[1]?.providerId, 'groq');
  assert.equal(attempts[1]?.category, 'ok');
});

test('FallbackProvider falls back for every error category at the request boundary', async () => {
  const categories = ['authentication', 'rate_limit', 'timeout', 'unavailable_model', 'malformed_response', 'network', 'unknown'] as const;
  for (const category of categories) {
    const nvidia = new StubProvider('nvidia', () => {
      throw new ProviderError('nvidia', category, `${category} failed`);
    });
    const groq = new StubProvider('groq', () => okResult);
    const router = new FallbackProvider([nvidia, groq]);
    const result = await router.chat(msgs);
    assert.equal(result.content, 'ok', `primary ${category} must fall back to Groq`);
    assert.equal(router.lastServed, groq);
  }
});

test('FallbackProvider aggregates a clear, secret-free error when every provider fails', async () => {
  const nvidia = new StubProvider('nvidia', () => {
    throw new ProviderError('nvidia', 'network', 'could not reach nvidia');
  });
  const groq = new StubProvider('groq', () => {
    throw new ProviderError('groq', 'authentication', 'bad groq key');
  });
  const router = new FallbackProvider([nvidia, groq]);

  await assert.rejects(
    () => router.chat(msgs),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(router.lastServed, null);
      const message = err.message;
      assert.match(message, /All AI providers failed/);
      assert.match(message, /NVIDIA NIM/);
      assert.match(message, /Groq/);
      assert.ok(!message.includes('bad groq key'), 'provider detail stays out of the user-facing summary');
      return true;
    },
  );
});

test('FallbackProvider.setModel delegates and getModel/listModels use the primary', async () => {
  const nvidia = new StubProvider('nvidia', () => okResult);
  const groq = new StubProvider('groq', () => okResult);
  const router = new FallbackProvider([nvidia, groq]);
  router.setModel('openai/gpt-oss-20b');
  assert.equal(router.getModel().id, 'm');
  const models = await router.listModels();
  assert.deepEqual(models, ['nvidia']);
});

test('FallbackProvider.streamChat buffers through chat (never falls back mid-stream)', async () => {
  const nvidia = new StubProvider('nvidia', () => {
    throw new ProviderError('nvidia', 'timeout', 'timed out');
  });
  const groq = new StubProvider('groq', () => ({ content: 'from groq', toolCalls: [], finishReason: 'stop' }));
  const router = new FallbackProvider([nvidia, groq]);
  const events: string[] = [];
  for await (const e of router.streamChat(msgs)) events.push(e.type);
  assert.deepEqual(events, ['content', 'done']);
});

test('FallbackProvider requires at least two providers', () => {
  assert.throws(() => new FallbackProvider([new StubProvider('groq', () => okResult)]), /at least two/);
});

// ---------------------------------------------------------------------------
// createServerRouter (server-side Model Router)
// ---------------------------------------------------------------------------

test('createServerRouter builds Groq primary → NVIDIA fallback when both keys are set', () => {
  process.env.NVIDIA_API_KEY = 'nvapi-fake';
  process.env.GROQ_API_KEY = 'gsk-fake';
  const result = createServerRouter('nvidia/llama-3.3-nemotron-super-49b-v1.5');
  assert.ok('provider' in result);
  if ('provider' in result) {
    assert.ok(result.provider instanceof FallbackProvider);
    const router = result.provider as FallbackProvider;
    assert.equal(router.primary.id, 'groq', 'Groq must be the primary provider');
    // The requested NVIDIA-hosted model is not served by Groq — the router
    // resolves the Groq coding default for the primary leg.
    assert.equal(router.primary.getModel().id, 'openai/gpt-oss-120b');
  }
});

test('createServerRouter is Groq-only (backward compatible) without an NVIDIA key', () => {
  process.env.GROQ_API_KEY = 'gsk-fake';
  const result = createServerRouter();
  assert.ok('provider' in result);
  if ('provider' in result) {
    assert.ok(result.provider instanceof GroqProvider, 'single-key chain is the plain Groq provider');
  }
});

test('createServerRouter is NVIDIA-only when only NVIDIA is configured', () => {
  process.env.NVIDIA_API_KEY = 'nvapi-fake';
  const result = createServerRouter();
  assert.ok('provider' in result);
  if ('provider' in result) {
    assert.ok(result.provider instanceof NvidiaProvider);
  }
});

test('createServerRouter uses the Groq-first chain for fast tasks', () => {
  process.env.NVIDIA_API_KEY = 'nvapi-fake';
  process.env.GROQ_API_KEY = 'gsk-fake';
  const result = createServerRouter(undefined, 'fast');
  assert.ok('provider' in result);
  if ('provider' in result) {
    const router = result.provider as FallbackProvider;
    assert.equal(router.primary.id, 'groq', 'fast tasks lead with Groq');
  }
});

test('resolveModelForProvider never hands a provider a model it does not serve', () => {
  // A Groq-only request for an NVIDIA-only model falls back to the Groq coding model.
  assert.equal(resolveModelForProvider('groq', 'nvidia/llama-3.3-nemotron-super-49b-v1.5', 'coding'), 'openai/gpt-oss-120b');
  // The same model IS served by NVIDIA.
  assert.equal(resolveModelForProvider('nvidia', 'nvidia/llama-3.3-nemotron-super-49b-v1.5', 'coding'), 'nvidia/llama-3.3-nemotron-super-49b-v1.5');
  // Tier defaults when nothing is requested.
  assert.equal(resolveModelForProvider('nvidia', undefined, 'reasoning'), 'nvidia/llama-3.3-nemotron-super-49b-v1.5');
  assert.equal(resolveModelForProvider('groq', undefined, 'fast'), 'openai/gpt-oss-20b');
  // The user's explicitly chosen Groq model is honored on the coding tier.
  assert.equal(resolveModelForProvider('groq', 'openai/gpt-oss-120b', 'coding'), 'openai/gpt-oss-120b');
});

test('serverRoutingPreference is Groq → NVIDIA → Gemini → MiniMax (fast leads with Groq)', () => {
  assert.deepEqual([...serverRoutingPreference('fast')], ['groq', 'nvidia', 'gemini', 'minimax']);
  assert.deepEqual([...serverRoutingPreference('coding')], ['groq', 'nvidia', 'gemini', 'minimax']);
  assert.deepEqual([...serverRoutingPreference()], ['groq', 'nvidia', 'gemini', 'minimax']);
});

test('serverRoutingPreference honors the ZEESH_SERVER_ROUTING override', () => {
  process.env.ZEESH_SERVER_ROUTING = 'minimax, gemini';
  try {
    assert.deepEqual([...serverRoutingPreference('coding')], ['minimax', 'gemini']);
  } finally {
    delete process.env.ZEESH_SERVER_ROUTING;
  }
});

test('createServerRouter errors when no server-side key is configured', () => {
  const result = createServerRouter();
  assert.ok('error' in result);
  if ('error' in result) {
    assert.match(result.error, /GROQ_API_KEY/);
    assert.match(result.error, /NVIDIA_API_KEY/);
    assert.match(result.error, /GEMINI_API_KEY/);
    assert.match(result.error, /MINIMAX_API_KEY/);
  }
});

// ---------------------------------------------------------------------------
// runServerChat (the /api/provider model-request boundary)
// ---------------------------------------------------------------------------

function stubProviderChats(): { restore(): void } {
  const originalN = NvidiaProvider.prototype.chat;
  const originalG = GroqProvider.prototype.chat;
  return {
    restore: () => {
      NvidiaProvider.prototype.chat = originalN;
      GroqProvider.prototype.chat = originalG;
    },
  };
}

test('runServerChat falls back from Groq to NVIDIA and reports the serving provider', async () => {
  process.env.NVIDIA_API_KEY = 'nvapi-fake';
  process.env.GROQ_API_KEY = 'gsk-fake';
  const stubs = stubProviderChats();
  GroqProvider.prototype.chat = (async () => {
    throw new ProviderError('groq', 'rate_limit', 'groq rate limited', 429);
  }) as typeof GroqProvider.prototype.chat;
  NvidiaProvider.prototype.chat = (async () => ({
    content: 'served by nvidia',
    toolCalls: [],
    finishReason: 'stop',
  })) as typeof NvidiaProvider.prototype.chat;
  try {
    const outcome = await runServerChat({ messages: msgs });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.result.content, 'served by nvidia');
      assert.equal(outcome.providerId, 'nvidia', 'the fallback provider must be reported');
      assert.ok(outcome.providerLabel.length > 0);
    }
  } finally {
    stubs.restore();
  }
});

test('runServerChat falls back to an available NVIDIA model when the requested one is not in the catalog', async () => {
  process.env.NVIDIA_API_KEY = 'nvapi-fake';
  const originalChat = NvidiaProvider.prototype.chat;
  const originalList = NvidiaProvider.prototype.listModels;
  let servedModel: string | null = null;
  NvidiaProvider.prototype.listModels = (async () => ['meta/llama-3.1-8b-instruct', 'nvidia/llama-3.3-nemotron-super-49b-v1.5']) as typeof NvidiaProvider.prototype.listModels;
  NvidiaProvider.prototype.chat = (async function (this: NvidiaProvider) {
    servedModel = (this as unknown as { modelId: string }).modelId;
    return { content: 'served by nvidia', toolCalls: [], finishReason: 'stop' };
  }) as typeof NvidiaProvider.prototype.chat;
  try {
    const outcome = await runServerChat({ messages: msgs, model: 'openai/gpt-oss-120b', tier: 'coding' });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.providerId, 'nvidia');
      assert.equal(
        servedModel,
        'nvidia/llama-3.3-nemotron-super-49b-v1.5',
        'a model NVIDIA does not serve gracefully falls back to an available NVIDIA model',
      );
    }
  } finally {
    NvidiaProvider.prototype.chat = originalChat;
    NvidiaProvider.prototype.listModels = originalList;
  }
});

test('runServerChat maps a total failure to a safe 502 with a clear message', async () => {
  process.env.NVIDIA_API_KEY = 'nvapi-fake';
  process.env.GROQ_API_KEY = 'gsk-fake';
  const stubs = stubProviderChats();
  NvidiaProvider.prototype.chat = (async () => {
    throw new ProviderError('nvidia', 'network', 'nvidia unreachable');
  }) as typeof NvidiaProvider.prototype.chat;
  GroqProvider.prototype.chat = (async () => {
    throw new ProviderError('groq', 'network', 'groq unreachable');
  }) as typeof GroqProvider.prototype.chat;
  try {
    const outcome = await runServerChat({ messages: msgs });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.status, 502);
      // The router aggregate names every failed provider — scrubbed and safe.
      assert.match(outcome.error, /All AI providers failed/);
      assert.match(outcome.error, /NVIDIA NIM/);
      assert.match(outcome.error, /Groq/);
      assert.ok(!outcome.error.includes('nvapi-fake'), 'the API key must never appear in the error');
      assert.ok(!outcome.error.includes('gsk-fake'));
    }
  } finally {
    stubs.restore();
  }
});

test('runServerChat surfaces a single-provider rate limit as 429', async () => {
  process.env.GROQ_API_KEY = 'gsk-fake';
  const stubs = stubProviderChats();
  GroqProvider.prototype.chat = (async () => {
    throw new ProviderError('groq', 'rate_limit', 'groq rate limited', 429);
  }) as typeof GroqProvider.prototype.chat;
  try {
    const outcome = await runServerChat({ messages: msgs });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.status, 429);
      assert.match(outcome.error, /rate limit/);
    }
  } finally {
    stubs.restore();
  }
});

test('runServerChat validates the messages payload before any provider call', async () => {
  const outcome = await runServerChat({ messages: [] });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.status, 400);
});

// ---------------------------------------------------------------------------
// describeCategory (user-safe labels used in the aggregate error)
// ---------------------------------------------------------------------------

test('describeCategory produces safe labels for every category', () => {
  assert.equal(describeCategory('rate_limit'), 'rate limit hit');
  assert.equal(describeCategory('quota_exhausted'), 'quota exhausted');
  assert.equal(describeCategory('authentication'), 'authentication failed');
  assert.equal(describeCategory('timeout'), 'timed out');
  assert.equal(describeCategory('unavailable_model'), 'model unavailable');
  assert.equal(describeCategory('server_error'), 'provider outage');
  assert.equal(describeCategory('malformed_response'), 'malformed response');
  assert.equal(describeCategory('network'), 'network failure');
  assert.equal(describeCategory('unknown'), 'request failed');
});

test('every provider-level failure category is fallback-eligible', () => {
  for (const category of [
    'authentication',
    'rate_limit',
    'quota_exhausted',
    'timeout',
    'unavailable_model',
    'server_error',
    'malformed_response',
    'network',
    'unknown',
  ] as const) {
    assert.equal(isFallbackEligible(category), true, `${category} is a provider-level failure`);
  }
});
