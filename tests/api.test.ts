import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setDbForTests, type Db, type Row } from '../src/api/db.ts';
import { runServerChat, createServerProvider } from '../src/api/providers.ts';
import { resetRateLimiters } from '../src/api/rateLimit.ts';
import { createApiServer } from '../src/api/server.ts';
import { GroqProvider } from '../src/providers/groq.ts';
import { UsageError, UsageService } from '../src/api/usage.ts';
import type { UsageReport } from '../src/api/usage.ts';
import { createMemoryDb } from './helpers/memoryDb.ts';

after(() => {
  delete process.env.DATABASE_URL;
  delete process.env.GROQ_API_KEY;
  delete process.env.ZEESH_AUTH_RATE_LIMIT_MAX;
  delete process.env.ZEESH_API_RATE_LIMIT_MAX;
  setDbForTests(null);
});

/** Reset shared state between tests so ordering never matters. */
afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.GROQ_API_KEY;
  delete process.env.ZEESH_AUTH_RATE_LIMIT_MAX;
  delete process.env.ZEESH_API_RATE_LIMIT_MAX;
  setDbForTests(null);
  resetRateLimiters();
});

/** A fake Db that returns fixed rows and records every call. */
function fakeDb(rows: Row[] = [], onQuery?: (query: string, params: unknown[]) => void): Db {
  return (async (query: string, params: unknown[] = []) => {
    onQuery?.(query, params);
    return rows;
  }) as Db;
}

/** A fake Db that returns a different result per call (call 0, 1, 2…). */
function fakeDbSequence(rowsByCall: Row[][], onQuery?: (query: string, params: unknown[]) => void): Db {
  let call = 0;
  return (async (query: string, params: unknown[] = []) => {
    onQuery?.(query, params);
    const rows = rowsByCall[call] ?? [];
    call += 1;
    return rows;
  }) as Db;
}

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createApiServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function request(
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(baseUrl + path, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

/** Register a user against a memory-backed server and return the session token. */
async function registerSession(baseUrl: string, email = 'dev@example.com'): Promise<string> {
  const { status, body } = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { email, password: 'hunter2-strong' },
  });
  assert.equal(status, 201);
  return (body as { token: string }).token;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

test('GET /api/health returns ok when no database is configured', async () => {
  delete process.env.DATABASE_URL;
  const { server, baseUrl } = await startServer();
  try {
    const { status, body } = await request(baseUrl, '/api/health');
    assert.equal(status, 200);
    const b = body as { status: string; database: string; auth: string; version: string };
    assert.equal(b.status, 'ok');
    assert.equal(b.database, 'not_configured');
    assert.equal(b.auth, 'not_configured');
    assert.equal(typeof b.version, 'string');
  } finally {
    server.close();
  }
});

test('GET /api/health reports database status from the configured client', async () => {
  delete process.env.DATABASE_URL;
  const { server, baseUrl } = await startServer();
  try {
    setDbForTests(fakeDb([], (q) => assert.equal(q, 'SELECT 1')));
    let b = (await request(baseUrl, '/api/health')).body as { database: string };
    assert.equal(b.database, 'connected');

    setDbForTests((async () => {
      throw new Error('connection refused');
    }) as unknown as Db);
    b = (await request(baseUrl, '/api/health')).body as { database: string };
    assert.equal(b.database, 'error');
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('unknown routes return 404', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const { status } = await request(baseUrl, '/api/nope');
    assert.equal(status, 404);
  } finally {
    server.close();
  }
});

test('known paths with a wrong method answer 405 with an Allow header', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(baseUrl + '/api/health', { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET');
    const res2 = await fetch(baseUrl + '/api/auth/me', { method: 'POST' });
    assert.equal(res2.status, 405);
    assert.equal(res2.headers.get('allow'), 'GET');
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Authentication endpoints
// ---------------------------------------------------------------------------

test('POST /api/auth/register creates an account and returns a session', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const { status, body } = await request(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: { email: 'dev@example.com', password: 'hunter2-strong', display_name: 'Dev' },
    });
    assert.equal(status, 201);
    const b = body as { user: { id: string; email: string; display_name: string | null }; token: string; expires_at: string };
    assert.equal(b.user.email, 'dev@example.com');
    assert.equal(b.user.display_name, 'Dev');
    assert.ok(b.token.length >= 32);
    assert.ok(b.expires_at);

    // Plaintext password never stored.
    assert.ok(!JSON.stringify(mem.users).includes('hunter2-strong'));
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('register validates email, password length and duplicates', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    let r = await request(baseUrl, '/api/auth/register', { method: 'POST', body: { email: 'nope', password: 'hunter2-strong' } });
    assert.equal(r.status, 400);
    r = await request(baseUrl, '/api/auth/register', { method: 'POST', body: { email: 'a@b.com', password: 'short' } });
    assert.equal(r.status, 400);

    const ok = await request(baseUrl, '/api/auth/register', { method: 'POST', body: { email: 'a@b.com', password: 'hunter2-strong' } });
    assert.equal(ok.status, 201);
    const dup = await request(baseUrl, '/api/auth/register', { method: 'POST', body: { email: 'a@b.com', password: 'hunter2-strong' } });
    assert.equal(dup.status, 409);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('POST /api/auth/login returns a session for valid credentials only', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    await request(baseUrl, '/api/auth/register', { method: 'POST', body: { email: 'dev@example.com', password: 'hunter2-strong' } });

    const ok = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { email: 'dev@example.com', password: 'hunter2-strong' } });
    assert.equal(ok.status, 200);
    assert.ok((ok.body as { token: string }).token);

    const bad = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { email: 'dev@example.com', password: 'wrong-password' } });
    assert.equal(bad.status, 401);
    const missing = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { email: 'ghost@example.com', password: 'hunter2-strong' } });
    assert.equal(missing.status, 401);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('protected endpoints reject missing or invalid session tokens', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const noToken = await request(baseUrl, '/api/auth/me');
    assert.equal(noToken.status, 401);
    const badToken = await request(baseUrl, '/api/auth/me', { token: 'not-a-real-token' });
    assert.equal(badToken.status, 401);

    const usageNoToken = await request(baseUrl, '/api/usage', { method: 'POST', body: { user_id: 'u', model: 'm', input_tokens: 1, output_tokens: 1, agent_turns: 1 } });
    assert.equal(usageNoToken.status, 401);

    const providerNoToken = await request(baseUrl, '/api/provider', { method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }] } });
    assert.equal(providerNoToken.status, 401);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('GET /api/auth/me returns the session user', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const token = await registerSession(baseUrl, 'me@example.com');
    const { status, body } = await request(baseUrl, '/api/auth/me', { token });
    assert.equal(status, 200);
    assert.equal((body as { user: { email: string } }).user.email, 'me@example.com');
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('POST /api/auth/logout invalidates the session', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const token = await registerSession(baseUrl, 'bye@example.com');
    const out = await request(baseUrl, '/api/auth/logout', { method: 'POST', token });
    assert.equal(out.status, 200);

    const after = await request(baseUrl, '/api/auth/me', { token });
    assert.equal(after.status, 401);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('auth endpoints return 503 when no database is configured', async () => {
  delete process.env.DATABASE_URL;
  setDbForTests(null);
  const { server, baseUrl } = await startServer();
  try {
    const { status, body } = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { email: 'a@b.com', password: 'x'.repeat(10) } });
    assert.equal(status, 503);
    assert.match((body as { error: string }).error, /DATABASE_URL/);
  } finally {
    server.close();
  }
});

test('auth endpoints are rate-limited per IP (429)', async () => {
  process.env.ZEESH_AUTH_RATE_LIMIT_MAX = '3';
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  resetRateLimiters();
  const { server, baseUrl } = await startServer();
  try {
    let lastStatus = 0;
    for (let i = 0; i < 5; i += 1) {
      const r = await request(baseUrl, '/api/auth/login', { method: 'POST', body: { email: 'a@b.com', password: 'wrong-pass' } });
      lastStatus = r.status;
    }
    assert.equal(lastStatus, 429);
    const res = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com', password: 'wrong-pass' }),
    });
    assert.ok(Number(res.headers.get('retry-after')) >= 1);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Usage recording (session-scoped)
// ---------------------------------------------------------------------------

test('POST /api/usage records a run for the session user and returns 201', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const token = await registerSession(baseUrl, 'usage@example.com');
    const body = {
      user_id: 'someone-else', // must be ignored — session is the source of truth
      model: 'openai/gpt-oss-120b',
      input_tokens: 120,
      output_tokens: 80,
      agent_turns: 3,
      tool_calls: 5,
      execution_time_ms: 1234,
    };
    const { status, body: res } = await request(baseUrl, '/api/usage', { method: 'POST', body, token });
    assert.equal(status, 201);
    assert.equal((res as { recorded: boolean }).recorded, true);
    assert.equal(mem.runs.length, 1);
    assert.notEqual(mem.runs[0]?.user_id, 'someone-else');
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('POST /api/usage rejects invalid payloads with 400', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const token = await registerSession(baseUrl);
    const bad = [
      { user_id: 'u', model: '', input_tokens: 1, output_tokens: 1, agent_turns: 1 }, // empty model
      { user_id: 'u', model: 'm', input_tokens: -1, output_tokens: 1, agent_turns: 1 }, // negative
      { user_id: 'u', model: 'm', input_tokens: 1, output_tokens: 1.5, agent_turns: 1 }, // non-integer
      { user_id: 'u', model: 'm', input_tokens: 1, output_tokens: 1, agent_turns: -2 }, // negative turns
      { user_id: 'u', model: 'm', input_tokens: 1, output_tokens: 1, agent_turns: 1, status: 'bogus' }, // bad status
      'not-an-object', // non-object body
    ];
    for (const b of bad) {
      const { status } = await request(baseUrl, '/api/usage', { method: 'POST', body: b, token });
      assert.equal(status, 400, `expected 400 for ${JSON.stringify(b)}`);
    }
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('GET /api/usage is scoped to the authenticated user', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const tokenA = await registerSession(baseUrl, 'alice@example.com');
    const tokenB = await registerSession(baseUrl, 'bob@example.com');

    const report = { user_id: 'ignored', model: 'm', input_tokens: 10, output_tokens: 5, agent_turns: 1 };
    await request(baseUrl, '/api/usage', { method: 'POST', body: report, token: tokenA });
    await request(baseUrl, '/api/usage', { method: 'POST', body: report, token: tokenA });
    await request(baseUrl, '/api/usage', { method: 'POST', body: report, token: tokenB });

    const a = await request(baseUrl, '/api/usage?limit=10', { token: tokenA });
    assert.equal(a.status, 200);
    assert.equal((a.body as { usage: Row[] }).usage.length, 2);

    const b = await request(baseUrl, '/api/usage?limit=10', { token: tokenB });
    assert.equal((b.body as { usage: Row[] }).usage.length, 1);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

// ---------------------------------------------------------------------------
// UsageService (unit level)
// ---------------------------------------------------------------------------

test('UsageService validates required fields', async () => {
  const svc = new UsageService(fakeDb());
  const missingUser = { model: 'm', input_tokens: 1, output_tokens: 1, agent_turns: 1 } as unknown as UsageReport;
  await assert.rejects(
    () => svc.recordUsage(missingUser),
    (err: unknown) => err instanceof UsageError && err.status === 400,
  );
});

test('UsageService inserts an agent_run and a usage row with the right values', async () => {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const svc = new UsageService(fakeDb([{ id: 42 }], (query, params) => calls.push({ query, params })));

  const { runId } = await svc.recordUsage({
    user_id: 'u-1',
    model: 'm',
    input_tokens: 10,
    output_tokens: 4,
    agent_turns: 2,
    tool_calls: 3,
    execution_time_ms: 999,
    client_run_id: 'run-abc',
  });

  assert.equal(runId, 42);
  assert.equal(calls.length, 2);
  const run = calls[0];
  assert.ok(run?.query.includes('INSERT INTO agent_runs'));
  assert.equal(run?.params[0], 'run-abc'); // client_run_id
  assert.equal(run?.params[1], 'u-1'); // user_id
  assert.equal(run?.params[7], 2); // agent_turns
  assert.equal(run?.params[11], 999); // execution_time_ms
  assert.ok(calls[1]?.query.includes('INSERT INTO usage'));
});

test('duplicate client_run_id is idempotent and does not double-record usage', async () => {
  const queries: string[] = [];
  // First INSERT conflicts (no row); the SELECT finds the existing run.
  const svc = new UsageService(fakeDbSequence([[], [{ id: 99 }]], (q) => queries.push(q)));
  const { runId } = await svc.recordUsage({
    user_id: 'u',
    model: 'm',
    input_tokens: 1,
    output_tokens: 1,
    agent_turns: 1,
    client_run_id: 'dup',
  });
  assert.equal(runId, 99);
  assert.equal(queries.length, 2, 'insert (conflict) + select existing');
  assert.ok(queries[0]?.includes('ON CONFLICT'));
  assert.ok(queries[1]?.includes('SELECT id FROM agent_runs'));
  assert.ok(!queries.some((q) => q.includes('INSERT INTO usage')), 'no duplicate usage row');
});

test('UsageService truncates long prompts', async () => {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const svc = new UsageService(fakeDb([{ id: 1 }], (query, params) => calls.push({ query, params })));
  await svc.recordUsage({
    user_id: 'u',
    model: 'm',
    input_tokens: 1,
    output_tokens: 1,
    agent_turns: 1,
    prompt: 'x'.repeat(50_000),
  });
  const prompt = calls[0]?.params[4] as string;
  assert.equal(prompt.length, 20_000);
});

// ---------------------------------------------------------------------------
// Server-side provider layer
// ---------------------------------------------------------------------------

test('createServerProvider requires a server-side GROQ_API_KEY', () => {
  delete process.env.GROQ_API_KEY;
  const result = createServerProvider();
  assert.ok('error' in result);
});

test('createServerProvider builds a provider without network access', () => {
  process.env.GROQ_API_KEY = 'gsk_fake_key_for_tests';
  try {
    const result = createServerProvider();
    assert.ok('provider' in result);
    assert.ok(result.provider instanceof GroqProvider);
  } finally {
    delete process.env.GROQ_API_KEY;
  }
});

test('runServerChat validates the messages payload', async () => {
  const outcome = await runServerChat({ messages: [] });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.status, 400);
  }
});

test('runServerChat forwards tools to the provider options (agent tool calls work remotely)', async () => {
  process.env.GROQ_API_KEY = 'gsk_fake_key_for_tests';
  const original = GroqProvider.prototype.chat;
  let forwardedTools: unknown;
  GroqProvider.prototype.chat = (async (_messages, options = {}) => {
    forwardedTools = options.tools;
    return { content: 'ok', toolCalls: [], finishReason: 'stop' };
  }) as typeof GroqProvider.prototype.chat;
  try {
    const outcome = await runServerChat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read_file', description: 'Read', parameters: {} } }],
    });
    assert.equal(outcome.ok, true);
    assert.ok(Array.isArray(forwardedTools));
    assert.equal((forwardedTools as Array<{ function: { name: string } }>)[0]?.function.name, 'read_file');
  } finally {
    GroqProvider.prototype.chat = original;
    delete process.env.GROQ_API_KEY;
  }
});

test('POST /api/provider refuses when the server key is missing', async () => {
  delete process.env.GROQ_API_KEY;
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const token = await registerSession(baseUrl);
    const { status } = await request(baseUrl, '/api/provider', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      token,
    });
    assert.equal(status, 503);
  } finally {
    setDbForTests(null);
    server.close();
  }
});
