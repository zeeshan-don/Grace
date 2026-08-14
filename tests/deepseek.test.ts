/**
 * DeepSeek provider tests (mock fetch only — no real API, no key).
 *
 * Covers the OpenAI-compatible wire format, response mapping, the provider
 * error taxonomy and registration in the provider registry — proving the
 * provider architecture accepts DeepSeek without touching agent code.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DEFAULT_DEEPSEEK_MODEL, DeepSeekProvider } from '../src/providers/deepseek.ts';
import { createProvider, SUPPORTED_PROVIDERS } from '../src/providers/registry.ts';
import { ProviderError } from '../src/providers/errors.ts';
import { pickModelForProvider, isKnownModel } from '../src/agents/modelRouter.ts';
import type { ChatMessage, ToolCallParam, ToolDefinition, Usage } from '../src/providers/types.ts';

const FAKE_KEY = 'sk-test-deepseek-1234567890abcdef';
const BASE = 'http://deepseek.test';

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

function makeProvider(opts: { model?: string } = {}): DeepSeekProvider {
  return new DeepSeekProvider({ apiKey: FAKE_KEY, baseUrl: BASE, model: opts.model });
}

// ---------------------------------------------------------------------------
// chat — wire format + response mapping
// ---------------------------------------------------------------------------

test('DeepSeekProvider.chat sends the OpenAI-compatible wire format with the key as Bearer', async () => {
  const calls = stubFetch(() => jsonReply(200, { choices: [{ message: { content: 'Hello from DeepSeek' }, finish_reason: 'stop' }] }));
  const provider = makeProvider();
  const result = await provider.chat(msgs, { temperature: 0.5, maxTokens: 2048 });

  assert.equal(result.content, 'Hello from DeepSeek');
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.finishReason, 'stop');

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call, 'expected one fetch call');
  assert.equal(call.url, `${BASE}/chat/completions`);
  assert.equal(call.init.method, 'POST');
  assert.equal((call.init.headers as Record<string, string>).Authorization, `Bearer ${FAKE_KEY}`);
  const body = JSON.parse(String(call.init.body)) as {
    model: string;
    messages: ChatMessage[];
    temperature: number;
    max_tokens: number;
  };
  assert.equal(body.model, DEFAULT_DEEPSEEK_MODEL);
  assert.deepEqual(body.messages, msgs);
  assert.equal(body.temperature, 0.5);
  assert.equal(body.max_tokens, 2048);
});

test('DeepSeekProvider.chat maps tool calls and usage from the response', async () => {
  const usage: Usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
  const toolCall: ToolCallParam = { id: 'call_9', name: 'read_file', arguments: '{"path":"a.ts"}' };
  stubFetch(() =>
    jsonReply(200, {
      choices: [{ message: { content: null, tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  );
  const result = await makeProvider().chat(msgs);
  assert.deepEqual(result.toolCalls, [toolCall]);
  assert.deepEqual(result.usage, usage);
  assert.equal(result.finishReason, 'tool_calls');
});

test('DeepSeekProvider.chat serializes tool messages with tool_call_id (agent loop works)', async () => {
  const calls = stubFetch(() => jsonReply(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
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
  assert.equal(toolMsg.content, 'file contents');
});

test('DeepSeekProvider.chat forwards tools in the request body', async () => {
  const calls = stubFetch(() => jsonReply(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  const tools: ToolDefinition[] = [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: {} } }];
  await makeProvider().chat(msgs, { tools });
  const body = JSON.parse(String(calls[0]?.init.body)) as { tools: unknown };
  assert.deepEqual(body.tools, tools);
});

// ---------------------------------------------------------------------------
// Error taxonomy (mock HTTP failures — no real network)
// ---------------------------------------------------------------------------

test('DeepSeekProvider maps 401 to authentication and never leaks the key', async () => {
  stubFetch(() => jsonReply(401, { error: { message: 'Invalid API key provided', type: 'authentication_error' } }));
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError, 'expected ProviderError');
      assert.equal(err.category, 'authentication');
      assert.equal(err.status, 401);
      assert.ok(!err.message.includes(FAKE_KEY), 'error must not contain the API key');
      return true;
    },
  );
});

test('DeepSeekProvider maps 429 to rate_limit', async () => {
  stubFetch(() => jsonReply(429, { error: { message: 'Rate limit exceeded' } }));
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'rate_limit' && err.status === 429,
  );
});

test('DeepSeekProvider maps an unparseable response to malformed_response', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('<!DOCTYPE html>', { status: 200 })) as typeof fetch;
  stubs.push(() => {
    globalThis.fetch = original;
  });
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'malformed_response',
  );
});

test('DeepSeekProvider maps fetch network failures to network', async () => {
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

test('DeepSeekProvider.streamChat replays content, tool calls and usage as events', async () => {
  const usage: Usage = { inputTokens: 5, outputTokens: 3, totalTokens: 8 };
  stubFetch(() =>
    jsonReply(200, {
      choices: [{ message: { content: 'Doing:', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }),
  );
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const e of makeProvider().streamChat(msgs)) events.push(e as { type: string });
  assert.deepEqual(events.map((e) => e.type), ['content', 'tool_call_delta', 'done']);
  assert.equal(events[0]?.content, 'Doing:');
  assert.equal((events[2] as { usage?: Usage }).usage?.totalTokens, 8);
});

test('registry: deepseek is a registered, constructible provider', () => {
  assert.ok(SUPPORTED_PROVIDERS.includes('deepseek'));
  const provider = createProvider('deepseek', { apiKey: FAKE_KEY, model: 'deepseek-chat' });
  assert.ok(provider instanceof DeepSeekProvider);
  assert.equal(provider.getModel().id, 'deepseek-chat');
});

test('model tables: deepseek resolves known models for every tier', () => {
  assert.equal(pickModelForProvider('deepseek', 'coding'), 'deepseek-chat');
  assert.equal(pickModelForProvider('deepseek', 'reasoning'), 'deepseek-reasoner');
  assert.ok(isKnownModel('deepseek', 'deepseek-chat'));
  assert.ok(isKnownModel('deepseek', 'deepseek-reasoner'));
  // A user's explicitly chosen DeepSeek model is honored on the coding tier.
  assert.equal(pickModelForProvider('deepseek', 'coding', 'deepseek-reasoner'), 'deepseek-reasoner');
});
