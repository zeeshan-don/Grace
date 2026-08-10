/**
 * Tests for the client-side remote provider (Milestone 11 wiring):
 *   - RemoteProvider proxies chat/streamChat to POST /api/provider with the
 *     session token, and maps the response back to AIProvider's contract.
 *   - resolveProvider picks the local Groq provider when a key exists and
 *     falls back to RemoteProvider when logged in without one.
 *
 * The mock HTTP server stands in for the ZEESH AI backend; no real network or
 * provider key is ever used.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import { NO_PROVIDER_MESSAGE, resolveProvider } from '../src/runtime.ts';
import { GroqProvider } from '../src/providers/groq.ts';
import { RemoteProvider, RemoteProviderError } from '../src/providers/remote.ts';
import type { ChatMessage, ToolCallParam, ToolDefinition, Usage } from '../src/providers/types.ts';
import type { StoredSession } from '../src/auth/session.ts';

const running: Server[] = [];

afterEach(() => {
  for (const s of running.splice(0)) s.close();
});

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: unknown;
}

interface MockReply {
  status: number;
  body: unknown;
}

async function startMock(respond: (req: CapturedRequest) => MockReply): Promise<{ server: Server; baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) : undefined,
      };
      requests.push(captured);
      const reply = respond(captured);
      res.statusCode = reply.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const handle = { server, baseUrl: `http://127.0.0.1:${port}`, requests };
  running.push(server);
  return handle;
}

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    apiUrl: 'https://zeesh-ai.vercel.app',
    token: 't'.repeat(64),
    user: { id: 'u-1', email: 'dev@example.com', displayName: null },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];

const toolDef: ToolDefinition = {
  type: 'function',
  function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
};

// ---------------------------------------------------------------------------
// RemoteProvider.chat
// ---------------------------------------------------------------------------

test('RemoteProvider.chat sends the session token + payload and maps the response', async () => {
  const toolCall: ToolCallParam = { id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' };
  const usage: Usage = { inputTokens: 100, outputTokens: 40, totalTokens: 140 };
  const mock = await startMock(() => ({
    status: 200,
    body: { content: 'Here is the file.', tool_calls: [toolCall], usage, finish_reason: 'tool_calls' },
  }));

  const provider = new RemoteProvider({ apiUrl: mock.baseUrl, token: 'tok-123', model: 'm-1' });
  const result = await provider.chat(msgs, { temperature: 0.5, tools: [toolDef] });

  assert.equal(result.content, 'Here is the file.');
  assert.deepEqual(result.toolCalls, [toolCall]);
  assert.deepEqual(result.usage, usage);
  assert.equal(result.finishReason, 'tool_calls');

  assert.equal(mock.requests.length, 1);
  const req = mock.requests[0];
  assert.ok(req, 'expected one captured request');
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/api/provider');
  assert.equal(req.headers.authorization, 'Bearer tok-123');
  assert.match(req.headers['content-type'] ?? '', /application\/json/);
  const body = req.body as { messages: ChatMessage[]; model: string; temperature: number; tools: ToolDefinition[] };
  assert.deepEqual(body.messages, msgs);
  assert.equal(body.model, 'm-1');
  assert.equal(body.temperature, 0.5);
  assert.deepEqual(body.tools, [toolDef]);
});

test('RemoteProvider.chat tolerates missing optional fields in the response', async () => {
  const mock = await startMock(() => ({ status: 200, body: { content: 'ok' } }));
  const provider = new RemoteProvider({ apiUrl: mock.baseUrl, token: 'tok' });
  const result = await provider.chat(msgs);
  assert.equal(result.content, 'ok');
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.usage, undefined);
  assert.equal(result.finishReason, 'stop');
  assert.equal(provider.lastSession, null, 'no session field → nothing to display');
});

test('RemoteProvider captures the ZEESH FREE session state from the response', async () => {
  const mock = await startMock(() => ({
    status: 200,
    body: {
      content: 'ok',
      finish_reason: 'stop',
      session: {
        sessionsUsed: 2,
        sessionsRemaining: 4,
        currentSession: 2,
        sessionStartedAt: '2026-08-10T09:00:00.000Z',
        sessionExpiresAt: '2026-08-10T10:00:00.000Z',
        dailyUsedSeconds: 3600,
        dailyLimitSeconds: 21600,
        startedNew: true,
      },
    },
  }));
  const provider = new RemoteProvider({ apiUrl: mock.baseUrl, token: 'tok' });
  await provider.chat(msgs);
  assert.equal(provider.lastSession?.currentSession, 2);
  assert.equal(provider.lastSession?.startedNew, true, 'rollover is surfaced to the CLI');
  assert.equal(provider.lastSession?.sessionsRemaining, 4);
});

test('RemoteProvider maps 429 daily_limit_exhausted to the server message', async () => {
  const mock = await startMock(() => ({
    status: 429,
    body: { error: 'You have used all 6 free sessions for today.', code: 'daily_limit_exhausted' },
  }));
  const provider = new RemoteProvider({ apiUrl: mock.baseUrl, token: 'tok' });
  await assert.rejects(
    () => provider.chat(msgs),
    (err: unknown) =>
      err instanceof RemoteProviderError &&
      err.status === 429 &&
      /all 6 free sessions/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// RemoteProvider.streamChat (buffered)
// ---------------------------------------------------------------------------

test('RemoteProvider.streamChat replays content, tool calls and usage as events', async () => {
  const toolCalls: ToolCallParam[] = [
    { id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    { id: 'c2', name: 'search_files', arguments: '{"query":"TODO"}' },
  ];
  const usage: Usage = { inputTokens: 50, outputTokens: 20, totalTokens: 70 };
  const mock = await startMock(() => ({
    status: 200,
    body: { content: 'Two calls:', tool_calls: toolCalls, usage, finish_reason: 'tool_calls' },
  }));

  const provider = new RemoteProvider({ apiUrl: mock.baseUrl, token: 'tok', model: 'm' });
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const e of provider.streamChat(msgs, { tools: [toolDef] })) {
    events.push(e as { type: string });
  }

  assert.deepEqual(
    events.map((e) => e.type),
    ['content', 'tool_call_delta', 'tool_call_delta', 'done'],
  );
  const first = events[0];
  assert.equal(first?.type, 'content');
  assert.equal(first?.content, 'Two calls:');
  const delta0 = events[1];
  assert.equal(delta0?.type, 'tool_call_delta');
  assert.equal(delta0?.index, 0);
  assert.equal(delta0?.id, 'c1');
  assert.equal(delta0?.name, 'read_file');
  assert.equal(delta0?.argumentsDelta, '{"path":"a.ts"}');
  const delta1 = events[2];
  assert.equal(delta1?.index, 1);
  assert.equal(delta1?.id, 'c2');
  const done = events[3];
  assert.equal(done?.type, 'done');
  assert.deepEqual(done?.usage, usage);
});

// ---------------------------------------------------------------------------
// RemoteProvider error handling
// ---------------------------------------------------------------------------

test('RemoteProvider maps 401 (expired session) to a login hint', async () => {
  const mock = await startMock(() => ({ status: 401, body: { error: 'Session invalid.' } }));
  const provider = new RemoteProvider({ apiUrl: mock.baseUrl, token: 'stale' });
  await assert.rejects(
    () => provider.chat(msgs),
    (err: unknown) => err instanceof RemoteProviderError && err.status === 401 && /zeesh login/.test(err.message),
  );
});

test('RemoteProvider maps 429 (rate limit) to a retry hint', async () => {
  const mock = await startMock(() => ({ status: 429, body: { error: 'Too many requests.' } }));
  const provider = new RemoteProvider({ apiUrl: mock.baseUrl, token: 'tok' });
  await assert.rejects(
    () => provider.chat(msgs),
    (err: unknown) => err instanceof RemoteProviderError && err.status === 429 && /rate limit/.test(err.message),
  );
});

test('RemoteProvider surfaces the server error message for other statuses', async () => {
  const mock = await startMock(() => ({ status: 503, body: { error: 'Server-side GROQ_API_KEY is not configured.' } }));
  const provider = new RemoteProvider({ apiUrl: mock.baseUrl, token: 'tok' });
  await assert.rejects(
    () => provider.chat(msgs),
    (err: unknown) =>
      err instanceof RemoteProviderError && err.status === 503 && /Server-side GROQ_API_KEY/.test(err.message),
  );
});

test('RemoteProvider throws a descriptive error when the backend is unreachable', async () => {
  const provider = new RemoteProvider({ apiUrl: 'http://127.0.0.1:1', token: 'tok', timeoutMs: 2000 });
  await assert.rejects(
    () => provider.chat(msgs),
    (err: unknown) => err instanceof RemoteProviderError && err.status === 0 && /Could not reach/.test(err.message),
  );
});

// ---------------------------------------------------------------------------
// resolveProvider (runtime wiring)
// ---------------------------------------------------------------------------

test('resolveProvider prefers a local GROQ_API_KEY', () => {
  const { provider, error } = resolveProvider('gsk_local', 'm-1', session());
  assert.ok(provider instanceof GroqProvider);
  assert.equal(error, null);
  assert.equal(provider.getModel().id, 'm-1');
});

test('resolveProvider falls back to RemoteProvider when logged in without a local key', () => {
  const s = session();
  const { provider, error } = resolveProvider(undefined, 'openai/gpt-oss-120b', s);
  assert.ok(provider instanceof RemoteProvider);
  assert.equal(error, null);
  assert.equal(provider.getModel().id, 'openai/gpt-oss-120b');
});

test('resolveProvider returns NO_PROVIDER_MESSAGE with no key and no session', () => {
  const { provider, error } = resolveProvider(undefined, 'm-1', null);
  assert.equal(provider, null);
  assert.equal(error, NO_PROVIDER_MESSAGE);
});

test('resolveProvider ignores an expired session', () => {
  const expired = session({ expiresAt: new Date(Date.now() - 1000).toISOString() });
  const { provider, error } = resolveProvider(undefined, 'm-1', expired);
  assert.equal(provider, null);
  assert.equal(error, NO_PROVIDER_MESSAGE);
});
