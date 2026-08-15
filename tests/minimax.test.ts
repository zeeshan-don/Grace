/**
 * MiniMax provider tests (mock fetch only — no real API, no key).
 *
 * Covers the OpenAI-compatible wire format (reasoning_split, cached-token
 * usage), tool calling, response mapping, the provider error taxonomy
 * (including the HTTP-200 base_resp error convention) and registration in
 * the provider registry.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DEFAULT_MINIMAX_MODEL, MiniMaxProvider } from '../src/providers/minimax.ts';
import { createProvider, SUPPORTED_PROVIDERS } from '../src/providers/registry.ts';
import { ProviderError } from '../src/providers/errors.ts';
import { isKnownModel, pickModelForProvider } from '../src/agents/modelRouter.ts';
import type { ChatMessage, ToolCallParam, ToolDefinition, Usage } from '../src/providers/types.ts';

const FAKE_KEY = 'minimax-test-key-1234567890';
const BASE = 'http://minimax.test/v1';

interface FetchCall {
  url: string;
  init: RequestInit;
}

const stubs: Array<() => void> = [];

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.href;
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  stubs.push(() => {
    globalThis.fetch = original;
  });
  return calls;
}

afterEach(() => {
  for (const restore of stubs.splice(0)) restore();
});

function jsonReply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];

function makeProvider(opts: { model?: string } = {}): MiniMaxProvider {
  return new MiniMaxProvider({ apiKey: FAKE_KEY, baseUrl: BASE, model: opts.model });
}

// ---------------------------------------------------------------------------
// chat — wire format + response mapping
// ---------------------------------------------------------------------------

test('MiniMaxProvider.chat sends the OpenAI-compatible wire format with the key as Bearer', async () => {
  const calls = stubFetch(() =>
    jsonReply(200, {
      choices: [{ message: { content: 'Hello from MiniMax' }, finish_reason: 'stop' }],
      base_resp: { status_code: 0 },
    }),
  );
  const result = await makeProvider().chat(msgs, { temperature: 0.5, maxTokens: 2048 });

  assert.equal(result.content, 'Hello from MiniMax');
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.finishReason, 'stop');

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, `${BASE}/chat/completions`);
  assert.equal(call.init.method, 'POST');
  assert.equal((call.init.headers as Record<string, string>).Authorization, `Bearer ${FAKE_KEY}`);
  const body = JSON.parse(String(call.init.body)) as {
    model: string;
    messages: ChatMessage[];
    temperature: number;
    max_completion_tokens: number;
    reasoning_split: boolean;
  };
  assert.equal(body.model, DEFAULT_MINIMAX_MODEL);
  assert.deepEqual(body.messages, msgs);
  assert.equal(body.temperature, 0.5);
  assert.equal(body.max_completion_tokens, 2048, 'MiniMax uses max_completion_tokens');
  assert.equal(body.reasoning_split, true, 'thinking stays out of content');
});

test('MiniMaxProvider.chat maps tool calls and usage including cached tokens', async () => {
  const toolCall: ToolCallParam = { id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' };
  const usage: Usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 15 };
  stubFetch(() =>
    jsonReply(200, {
      choices: [
        {
          message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 15 },
      },
      base_resp: { status_code: 0 },
    }),
  );
  const result = await makeProvider().chat(msgs);
  assert.deepEqual(result.toolCalls, [toolCall]);
  assert.deepEqual(result.usage, usage);
  assert.equal(result.finishReason, 'tool_calls');
});

test('MiniMaxProvider.chat forwards tools in the request body', async () => {
  const calls = stubFetch(() =>
    jsonReply(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], base_resp: { status_code: 0 } }),
  );
  const tools: ToolDefinition[] = [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: {} } }];
  await makeProvider().chat(msgs, { tools });
  const body = JSON.parse(String(calls[0]?.init.body)) as { tools: unknown };
  assert.deepEqual(body.tools, tools);
});

test('MiniMaxProvider.chat serializes tool messages with tool_call_id (agent loop works)', async () => {
  const calls = stubFetch(() =>
    jsonReply(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], base_resp: { status_code: 0 } }),
  );
  const conversation: ChatMessage[] = [
    { role: 'user', content: 'read the file' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
    { role: 'tool', tool_call_id: 'c1', content: 'file contents' },
  ];
  await makeProvider().chat(conversation);
  const body = JSON.parse(String(calls[0]?.init.body)) as { messages: Array<Record<string, unknown>> };
  assert.equal(body.messages.length, 3);
  const toolMsg = body.messages[2] as { role: string; tool_call_id: string; content: string };
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.tool_call_id, 'c1');
});

// ---------------------------------------------------------------------------
// Error taxonomy (mock HTTP failures — no real network)
// ---------------------------------------------------------------------------

test('MiniMaxProvider maps 401 to authentication and never leaks the key', async () => {
  stubFetch(() => jsonReply(401, { error: { message: 'Invalid API key' } }));
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.category, 'authentication');
      assert.equal(err.status, 401);
      assert.ok(!err.message.includes(FAKE_KEY));
      return true;
    },
  );
});

test('MiniMaxProvider maps 429 quota wording to quota_exhausted', async () => {
  stubFetch(() => jsonReply(429, { error: { message: 'Quota exhausted, please recharge' } }));
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'quota_exhausted' && err.status === 429,
  );
});

test('MiniMaxProvider maps a plain 429 to rate_limit', async () => {
  stubFetch(() => jsonReply(429, { error: { message: 'Too many requests' } }));
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'rate_limit',
  );
});

test('MiniMaxProvider treats HTTP 200 + non-zero base_resp as an error', async () => {
  stubFetch(() => jsonReply(200, { choices: [], base_resp: { status_code: 1004, status_msg: 'Invalid API key' } }));
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'authentication',
  );
});

test('MiniMaxProvider maps 5xx to server_error (provider outage → fallback)', async () => {
  stubFetch(() => jsonReply(500, { error: { message: 'Internal error' } }));
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'server_error',
  );
});

test('MiniMaxProvider maps network failures to network', async () => {
  stubFetch(() => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'network',
  );
});

// ---------------------------------------------------------------------------
// streamChat (buffered) + registry + model routing tables
// ---------------------------------------------------------------------------

test('MiniMaxProvider.streamChat replays content, tool calls and usage as events', async () => {
  const usage: Usage = { inputTokens: 5, outputTokens: 3, totalTokens: 8, cachedInputTokens: 1 };
  stubFetch(() =>
    jsonReply(200, {
      choices: [
        {
          message: { content: 'Doing:', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, prompt_tokens_details: { cached_tokens: 1 } },
      base_resp: { status_code: 0 },
    }),
  );
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const e of makeProvider().streamChat(msgs)) events.push(e as { type: string });
  assert.deepEqual(events.map((e) => e.type), ['content', 'tool_call_delta', 'done']);
  assert.equal((events[2] as { usage?: Usage }).usage?.cachedInputTokens, 1);
});

test('registry: minimax is a registered, constructible provider', () => {
  assert.ok(SUPPORTED_PROVIDERS.includes('minimax'));
  const provider = createProvider('minimax', { apiKey: FAKE_KEY, model: 'MiniMax-M3' });
  assert.ok(provider instanceof MiniMaxProvider);
  assert.equal(provider.getModel().id, 'MiniMax-M3');
});

test('model tables: minimax resolves the configured model for every tier', () => {
  assert.equal(pickModelForProvider('minimax', 'coding'), DEFAULT_MINIMAX_MODEL);
  assert.equal(pickModelForProvider('minimax', 'reasoning'), DEFAULT_MINIMAX_MODEL);
  assert.ok(isKnownModel('minimax', DEFAULT_MINIMAX_MODEL));
});
