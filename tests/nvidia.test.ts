/**
 * NVIDIA NIM provider tests (mock fetch only — no real NVIDIA API, no key).
 *
 * Covers the OpenAI-compatible wire format, response mapping and the full
 * provider error taxonomy: authentication, rate limit, timeout, unavailable
 * model, malformed response and network failure — and that no error message
 * ever contains the API key.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { NvidiaProvider, DEFAULT_NVIDIA_MODEL } from '../src/providers/nvidia.ts';
import { ProviderError } from '../src/providers/errors.ts';
import type { ChatMessage, ToolCallParam, ToolDefinition, Usage } from '../src/providers/types.ts';

const FAKE_KEY = 'nvapi-test-key-abcdef1234567890';
const BASE = 'http://nvidia.test/v1';

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

function makeProvider(opts: { model?: string } = {}): NvidiaProvider {
  return new NvidiaProvider({ apiKey: FAKE_KEY, baseUrl: BASE, model: opts.model });
}

// ---------------------------------------------------------------------------
// chat — wire format + response mapping
// ---------------------------------------------------------------------------

test('NvidiaProvider.chat sends the OpenAI-compatible wire format with the key as Bearer', async () => {
  const calls = stubFetch(() => jsonReply(200, { choices: [{ message: { content: 'Hello from NVIDIA' }, finish_reason: 'stop' }] }));
  const provider = makeProvider();
  const result = await provider.chat(msgs, { temperature: 0.5, maxTokens: 2048 });

  assert.equal(result.content, 'Hello from NVIDIA');
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
  assert.equal(body.model, DEFAULT_NVIDIA_MODEL);
  assert.deepEqual(body.messages, msgs);
  assert.equal(body.temperature, 0.5);
  assert.equal(body.max_tokens, 2048);
});

test('NvidiaProvider.chat maps tool calls and usage from the response', async () => {
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

test('NvidiaProvider.chat serializes tool messages with tool_call_id (agent loop works)', async () => {
  const calls = stubFetch(() => jsonReply(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  const conversation: ChatMessage[] = [
    { role: 'user', content: 'read the file' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
    { role: 'tool', tool_call_id: 'c1', content: 'file contents' },
  ];
  await makeProvider().chat(conversation);

  const body = JSON.parse(String(calls[0]?.init.body)) as { messages: Array<Record<string, unknown>> };
  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[0]?.role, 'user');
  const assistant = body.messages[1] as { role: string; tool_calls: Array<{ function: { name: string } }> };
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.tool_calls[0]?.function.name, 'read_file');
  const toolMsg = body.messages[2] as { role: string; tool_call_id: string; content: string };
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.tool_call_id, 'c1');
  assert.equal(toolMsg.content, 'file contents');
});

test('NvidiaProvider.chat forwards tools in the request body', async () => {
  const calls = stubFetch(() => jsonReply(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  const tools: ToolDefinition[] = [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: {} } }];
  await makeProvider().chat(msgs, { tools });
  const body = JSON.parse(String(calls[0]?.init.body)) as { tools: unknown };
  assert.deepEqual(body.tools, tools);
});

// ---------------------------------------------------------------------------
// Error taxonomy (mock HTTP failures — no real network)
// ---------------------------------------------------------------------------

test('NvidiaProvider maps 401 to authentication and never leaks the key', async () => {
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

test('NvidiaProvider maps 429 to rate_limit', async () => {
  stubFetch(() => jsonReply(429, { error: { message: 'Rate limit exceeded' } }));
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'rate_limit' && err.status === 429,
  );
});

test('NvidiaProvider maps 408 and aborts to timeout', async () => {
  stubFetch(() => jsonReply(408, { error: { message: 'Request timeout' } }));
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'timeout',
  );

  // AbortSignal-style timeout rejection (fetch aborted before a response).
  stubFetch(() => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'timeout',
  );
});

test('NvidiaProvider maps 404 and 5xx to unavailable_model', async () => {
  stubFetch(() => jsonReply(404, { error: { message: "The model 'nope/model' does not exist" } }));
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'unavailable_model',
  );

  stubFetch(() => jsonReply(503, { error: { message: 'Model temporarily unavailable' } }));
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'unavailable_model',
  );
});

test('NvidiaProvider maps 410 Gone (end-of-life model) to unavailable_model', async () => {
  // NVIDIA returns problem-details payloads (type/title/status/detail — no
  // `error` key) for model rejection, e.g. an EOL model. This must classify
  // as unavailable_model so the router falls back instead of surfacing it.
  stubFetch(() =>
    jsonReply(410, {
      type: 'https://api.nvidia.com/errors/model-not-found',
      title: 'Gone',
      status: 410,
      detail: "The model 'qwen/qwen2.5-coder-32b-instruct' has reached its end of life and is no longer available.",
    }),
  );
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'unavailable_model',
  );
});

test('NvidiaProvider maps an unparseable response to malformed_response', async () => {
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

test('NvidiaProvider maps fetch network failures to network', async () => {
  stubFetch(() => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'network',
  );
});

// ---------------------------------------------------------------------------
// streamChat (buffered) + listModels + model switching
// ---------------------------------------------------------------------------

test('NvidiaProvider.streamChat replays content, tool calls and usage as events', async () => {
  stubFetch(() =>
    jsonReply(200, {
      choices: [{ message: { content: 'Doing:', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    }),
  );
  const provider = makeProvider();
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const e of provider.streamChat(msgs)) events.push(e as { type: string });

  assert.deepEqual(events.map((e) => e.type), ['content', 'tool_call_delta', 'done']);
  assert.equal(events[0]?.content, 'Doing:');
  assert.equal(events[1]?.index, 0);
  assert.equal(events[1]?.id, 'c1');
  assert.equal(events[1]?.name, 'read_file');
  assert.deepEqual(events[2]?.usage, { inputTokens: 4, outputTokens: 2, totalTokens: 6 });
});

test('NvidiaProvider.listModels lists ids from GET /models and degrades to []', async () => {
  stubFetch(() => jsonReply(200, { data: [{ id: 'openai/gpt-oss-20b' }, { id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5' }] }));
  const models = await makeProvider().listModels();
  assert.deepEqual(models, ['nvidia/llama-3.3-nemotron-super-49b-v1.5', 'openai/gpt-oss-20b']);

  stubFetch(() => jsonReply(500, { error: { message: 'boom' } }));
  assert.deepEqual(await makeProvider().listModels(), []);
});

test('NvidiaProvider.getModel/setModel expose the configured model', () => {
  const provider = makeProvider({ model: 'nvidia/llama-3.3-nemotron-super-49b-v1.5' });
  assert.equal(provider.getModel().id, 'nvidia/llama-3.3-nemotron-super-49b-v1.5');
  provider.setModel('openai/gpt-oss-20b');
  assert.equal(provider.getModel().id, 'openai/gpt-oss-20b');
  assert.equal(provider.id, 'nvidia');
  assert.ok(provider.label.includes('NVIDIA'));
});
