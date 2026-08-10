/**
 * Model Router tests: FallbackProvider (NVIDIA → Groq chain), the server-side
 * router builder (createServerRouter) and runServerChat fallback behavior.
 *
 * All providers are stubbed — no real NVIDIA/Groq API and no keys are used.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createServerRouter, runServerChat } from '../src/api/providers.ts';
import { describeCategory, ProviderError } from '../src/providers/errors.ts';
import { FallbackProvider } from '../src/providers/fallback.ts';
import { GroqProvider } from '../src/providers/groq.ts';
import { NvidiaProvider } from '../src/providers/nvidia.ts';
import type { AIProvider, ChatMessage, ChatOptions, ChatResult, ModelInfo } from '../src/providers/types.ts';

const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];

afterEach(() => {
  delete process.env.NVIDIA_API_KEY;
  delete process.env.GROQ_API_KEY;
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
  router.setModel('qwen/qwen2.5-coder-32b-instruct');
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

test('createServerRouter builds NVIDIA primary → Groq fallback when both keys are set', () => {
  process.env.NVIDIA_API_KEY = 'nvapi-fake';
  process.env.GROQ_API_KEY = 'gsk-fake';
  const result = createServerRouter('qwen/qwen2.5-coder-32b-instruct');
  assert.ok('provider' in result);
  if ('provider' in result) {
    assert.ok(result.provider instanceof FallbackProvider);
    const router = result.provider as FallbackProvider;
    assert.equal(router.primary.id, 'nvidia', 'NVIDIA must be the primary provider');
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

test('createServerRouter errors when no server-side key is configured', () => {
  const result = createServerRouter();
  assert.ok('error' in result);
  if ('error' in result) {
    assert.match(result.error, /NVIDIA_API_KEY/);
    assert.match(result.error, /GROQ_API_KEY/);
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

test('runServerChat falls back from NVIDIA to Groq and reports the serving provider', async () => {
  process.env.NVIDIA_API_KEY = 'nvapi-fake';
  process.env.GROQ_API_KEY = 'gsk-fake';
  const stubs = stubProviderChats();
  NvidiaProvider.prototype.chat = (async () => {
    throw new ProviderError('nvidia', 'rate_limit', 'nvidia rate limited', 429);
  }) as typeof NvidiaProvider.prototype.chat;
  GroqProvider.prototype.chat = (async () => ({
    content: 'served by groq',
    toolCalls: [],
    finishReason: 'stop',
  })) as typeof GroqProvider.prototype.chat;
  try {
    const outcome = await runServerChat({ messages: msgs });
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.result.content, 'served by groq');
      assert.equal(outcome.providerId, 'groq', 'the fallback provider must be reported');
      assert.ok(outcome.providerLabel.length > 0);
    }
  } finally {
    stubs.restore();
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
  assert.equal(describeCategory('authentication'), 'authentication failed');
  assert.equal(describeCategory('timeout'), 'timed out');
  assert.equal(describeCategory('unavailable_model'), 'model unavailable');
  assert.equal(describeCategory('malformed_response'), 'malformed response');
  assert.equal(describeCategory('network'), 'network failure');
  assert.equal(describeCategory('unknown'), 'request failed');
});
