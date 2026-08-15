/**
 * Gemini provider tests (mock fetch only — no real API, no key).
 *
 * Covers the Gemini REST wire format (contents/systemInstruction/functionCall/
 * functionResponse), response mapping (text, tool calls, usage incl. cached
 * tokens), the provider error taxonomy (quota exhaustion, rate limit, outage)
 * and registration in the provider registry.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DEFAULT_GEMINI_MODEL, GeminiProvider } from '../src/providers/gemini.ts';
import { createProvider, SUPPORTED_PROVIDERS } from '../src/providers/registry.ts';
import { ProviderError } from '../src/providers/errors.ts';
import { isKnownModel, pickModelForProvider } from '../src/agents/modelRouter.ts';
import type { ChatMessage, ToolCallParam, ToolDefinition, Usage } from '../src/providers/types.ts';

const FAKE_KEY = 'AIza-test-gemini-1234567890';
const BASE = 'http://gemini.test/v1beta';

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

function makeProvider(opts: { model?: string } = {}): GeminiProvider {
  return new GeminiProvider({ apiKey: FAKE_KEY, baseUrl: BASE, model: opts.model });
}

// ---------------------------------------------------------------------------
// chat — wire format + response mapping
// ---------------------------------------------------------------------------

test('GeminiProvider.chat sends the generateContent wire format with x-goog-api-key', async () => {
  const calls = stubFetch(() =>
    jsonReply(200, { candidates: [{ content: { parts: [{ text: 'Hello from Gemini' }] }, finishReason: 'STOP' }] }),
  );
  const result = await makeProvider().chat(msgs, { temperature: 0.4, maxTokens: 1024 });

  assert.equal(result.content, 'Hello from Gemini');
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.finishReason, 'stop');

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, `${BASE}/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
  assert.equal(call.init.method, 'POST');
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers['x-goog-api-key'], FAKE_KEY);
  assert.ok(!call.url.includes(FAKE_KEY), 'the key must never appear in the URL');
  const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
  assert.deepEqual((body.generationConfig as Record<string, unknown>).maxOutputTokens, 1024);
  assert.deepEqual((body.generationConfig as Record<string, unknown>).temperature, 0.4);
});

test('GeminiProvider.chat splits the system message into systemInstruction', async () => {
  const calls = stubFetch(() => jsonReply(200, { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }));
  const conversation: ChatMessage[] = [
    { role: 'system', content: 'You are GRACE.' },
    { role: 'user', content: 'hi' },
  ];
  await makeProvider().chat(conversation);
  const body = JSON.parse(String(calls[0]?.init.body)) as { systemInstruction: { parts: Array<{ text: string }> }; contents: unknown };
  assert.equal(body.systemInstruction.parts[0]?.text, 'You are GRACE.');
  assert.equal((body.contents as Array<{ role: string }>)[0]?.role, 'user', 'system is not duplicated into contents');
});

test('GeminiProvider.chat maps tool calls and usage (incl. cached tokens)', async () => {
  const toolCall: ToolCallParam = { id: 'call_0', name: 'read_file', arguments: '{"path":"a.ts"}' };
  const usage: Usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 40 };
  stubFetch(() =>
    jsonReply(200, {
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: 'read_file', args: { path: 'a.ts' } } },
            ],
            role: 'model',
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120, cachedContentTokenCount: 40 },
    }),
  );
  const result = await makeProvider().chat(msgs);
  assert.deepEqual(result.toolCalls, [toolCall], 'functionCall args are JSON-stringified');
  assert.deepEqual(result.usage, usage);
});

test('GeminiProvider.chat converts multi-turn tool conversations to functionResponse parts', async () => {
  const calls = stubFetch(() => jsonReply(200, { candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }));
  const conversation: ChatMessage[] = [
    { role: 'user', content: 'read the file' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }] },
    { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: '{"contents":"file body"}' },
  ];
  await makeProvider().chat(conversation);
  const body = JSON.parse(String(calls[0]?.init.body)) as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
  assert.equal(body.contents.length, 3, 'user → model(functionCall) → user(functionResponse)');
  const model = body.contents[1];
  assert.equal(model?.role, 'model');
  assert.deepEqual((model?.parts[0] as { functionCall: { name: string; args: unknown } }).functionCall, {
    name: 'read_file',
    args: { path: 'a.ts' },
  });
  const tool = body.contents[2];
  assert.equal(tool?.role, 'user');
  const fr = (tool?.parts[0] as { functionResponse: { name: string; response: unknown } }).functionResponse;
  assert.equal(fr.name, 'read_file');
  assert.deepEqual(fr.response, { contents: 'file body' }, 'JSON tool output is passed as the response struct');
});

test('GeminiProvider.chat forwards tools as functionDeclarations', async () => {
  const calls = stubFetch(() => jsonReply(200, { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }));
  const tools: ToolDefinition[] = [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: { type: 'object' } } }];
  await makeProvider().chat(msgs, { tools });
  const body = JSON.parse(String(calls[0]?.init.body)) as { tools: Array<{ functionDeclarations: unknown }> };
  assert.deepEqual(body.tools[0]?.functionDeclarations, [
    { name: 'read_file', description: 'Read', parameters: { type: 'object' } },
  ]);
});

test('GeminiProvider merges consecutive same-role messages (alternation safety)', async () => {
  const calls = stubFetch(() => jsonReply(200, { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }));
  const conversation: ChatMessage[] = [
    { role: 'user', content: 'first' },
    { role: 'user', content: 'second' },
  ];
  await makeProvider().chat(conversation);
  const body = JSON.parse(String(calls[0]?.init.body)) as { contents: Array<{ role: string; parts: Array<{ text?: string }> }> };
  assert.equal(body.contents.length, 1, 'two user turns merge into one');
  assert.equal(body.contents[0]?.parts.map((p) => p.text).join(' '), 'first second');
});

// ---------------------------------------------------------------------------
// Error taxonomy (mock HTTP failures — no real network)
// ---------------------------------------------------------------------------

test('GeminiProvider maps 401 to authentication and never leaks the key', async () => {
  stubFetch(() => jsonReply(401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Invalid API key' } }));
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

test('GeminiProvider maps RESOURCE_EXHAUSTED to quota_exhausted', async () => {
  stubFetch(() => jsonReply(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }));
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'quota_exhausted' && err.status === 429,
  );
});

test('GeminiProvider maps a plain 429 to rate_limit', async () => {
  stubFetch(() => jsonReply(429, { error: { code: 429, status: 'UNAVAILABLE', message: 'try later' } }));
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'rate_limit',
  );
});

test('GeminiProvider maps 5xx to server_error (provider outage → fallback)', async () => {
  stubFetch(() => jsonReply(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded' } }));
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'server_error',
  );
});

test('GeminiProvider maps 404 to unavailable_model', async () => {
  stubFetch(() => jsonReply(404, { error: { code: 404, status: 'NOT_FOUND', message: 'models/gemini-3.1-flash-lite not found' } }));
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'unavailable_model',
  );
});

test('GeminiProvider maps network failures to network and unparseable bodies to malformed_response', async () => {
  stubFetch(() => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'network',
  );

  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('not json', { status: 200 })) as typeof fetch;
  stubs.push(() => {
    globalThis.fetch = original;
  });
  await assert.rejects(
    () => makeProvider().chat(msgs),
    (err: unknown) => err instanceof ProviderError && err.category === 'malformed_response',
  );
});

// ---------------------------------------------------------------------------
// streamChat (buffered) + registry + model routing tables
// ---------------------------------------------------------------------------

test('GeminiProvider.streamChat replays content, tool calls and usage as events', async () => {
  stubFetch(() =>
    jsonReply(200, {
      candidates: [
        {
          content: { parts: [{ text: 'Doing: ' }, { functionCall: { name: 'read_file', args: {} } }], role: 'model' },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
    }),
  );
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const e of makeProvider().streamChat(msgs)) events.push(e as { type: string });
  assert.deepEqual(events.map((e) => e.type), ['content', 'tool_call_delta', 'done']);
});

test('registry: gemini is a registered, constructible provider', () => {
  assert.ok(SUPPORTED_PROVIDERS.includes('gemini'));
  const provider = createProvider('gemini', { apiKey: FAKE_KEY, model: 'gemini-3.1-flash-lite' });
  assert.ok(provider instanceof GeminiProvider);
  assert.equal(provider.getModel().id, 'gemini-3.1-flash-lite');
});

test('model tables: gemini resolves the configured model for every tier', () => {
  assert.equal(pickModelForProvider('gemini', 'coding'), DEFAULT_GEMINI_MODEL);
  assert.equal(pickModelForProvider('gemini', 'fast'), DEFAULT_GEMINI_MODEL);
  assert.ok(isKnownModel('gemini', DEFAULT_GEMINI_MODEL));
});
