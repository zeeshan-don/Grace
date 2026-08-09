/**
 * Milestone 12 tests: closed-beta gating, CORS/preflight, secret-safe error
 * handling + logging, API-scope rate limiting with Retry-After, and database
 * failure behavior (generic 500 — no internals leaked).
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, test } from 'node:test';
import { setDbForTests, type Db } from '../src/api/db.ts';
import { scrubForLogs } from '../src/api/log.ts';
import { resetRateLimiters } from '../src/api/rateLimit.ts';
import { createApiServer } from '../src/api/server.ts';
import { ApiClient, ApiError } from '../src/auth/client.ts';
import { betaAccessFor, betaMode } from '../src/api/beta.ts';
import { createMemoryDb } from './helpers/memoryDb.ts';

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.GROQ_API_KEY;
  delete process.env.ZEESH_AUTH_RATE_LIMIT_MAX;
  delete process.env.ZEESH_API_RATE_LIMIT_MAX;
  delete process.env.ZEESH_BETA_MODE;
  delete process.env.ZEESH_BETA_ALLOWLIST;
  delete process.env.ZEESH_CORS_ORIGIN;
  setDbForTests(null);
  resetRateLimiters();
});

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

async function registerSession(baseUrl: string, email = 'dev@example.com'): Promise<string> {
  const { status, body } = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { email, password: 'hunter2-strong' },
  });
  assert.equal(status, 201);
  return (body as { token: string }).token;
}

// ---------------------------------------------------------------------------
// Closed beta (Milestone 12)
// ---------------------------------------------------------------------------

test('betaAccessFor: open mode (default) allows everyone as beta', () => {
  delete process.env.ZEESH_BETA_MODE;
  delete process.env.ZEESH_BETA_ALLOWLIST;
  assert.equal(betaMode(), 'open');
  assert.deepEqual(betaAccessFor('AnyOne@Example.com'), { allowed: true, isBeta: true });
});

test('betaAccessFor: closed mode only allows allowlisted emails (case-insensitive)', () => {
  process.env.ZEESH_BETA_MODE = 'closed';
  process.env.ZEESH_BETA_ALLOWLIST = 'Beta1@Example.com,beta2@example.com';
  assert.equal(betaMode(), 'closed');
  assert.deepEqual(betaAccessFor('beta1@example.com'), { allowed: true, isBeta: true });
  assert.deepEqual(betaAccessFor('intruder@example.com'), { allowed: false, isBeta: false });
});

test('register works normally in open beta mode and flags is_beta', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const token = await registerSession(baseUrl, 'open@example.com');
    assert.ok(token);
    assert.equal(mem.users[0]?.is_beta, true);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('closed beta: validation failures (400) win over the gate (403)', async () => {
  process.env.ZEESH_BETA_MODE = 'closed';
  process.env.ZEESH_BETA_ALLOWLIST = 'beta@example.com';
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const badEmail = await request(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: { email: 'not-an-email', password: 'hunter2-strong' },
    });
    assert.equal(badEmail.status, 400);
    const shortPassword = await request(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: { email: 'beta@example.com', password: 'short' },
    });
    assert.equal(shortPassword.status, 400);
    assert.equal(mem.users.length, 0, 'no accounts created by malformed attempts');
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('closed beta blocks non-allowlisted registrations with 403', async () => {
  process.env.ZEESH_BETA_MODE = 'closed';
  process.env.ZEESH_BETA_ALLOWLIST = 'beta@example.com';
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const blocked = await request(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: { email: 'outsider@example.com', password: 'hunter2-strong' },
    });
    assert.equal(blocked.status, 403);
    assert.match((blocked.body as { error: string }).error, /closed beta/);
    assert.equal(mem.users.length, 0, 'no account created for blocked email');

    const allowed = await request(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: { email: 'BETA@example.com', password: 'hunter2-strong' },
    });
    assert.equal(allowed.status, 201);
    assert.equal(mem.users[0]?.is_beta, true);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

// ---------------------------------------------------------------------------
// CORS + preflight (Milestone 12)
// ---------------------------------------------------------------------------

test('all responses carry CORS headers and OPTIONS preflights return 204', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(baseUrl + '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.ok(res.headers.get('access-control-allow-headers')?.includes('Authorization'));

    const preflight = await fetch(baseUrl + '/api/usage', { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

    const notFound = await fetch(baseUrl + '/api/nope');
    assert.equal(notFound.status, 404);
    assert.equal(notFound.headers.get('access-control-allow-origin'), '*');
  } finally {
    server.close();
  }
});

test('CORS origin is configurable via ZEESH_CORS_ORIGIN', async () => {
  process.env.ZEESH_CORS_ORIGIN = 'https://app.example.com';
  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(baseUrl + '/api/health');
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.com');
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Safe error handling (no stack traces / internals leaked)
// ---------------------------------------------------------------------------

test('database failures surface as a generic 500 without leaking internals', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const token = await registerSession(baseUrl, 'db@example.com');

    // Swap in a db that throws on every query.
    setDbForTests((async () => {
      throw new Error('leak-me-123 connection refused');
    }) as unknown as Db);

    const r = await request(baseUrl, '/api/auth/me', { token });
    assert.equal(r.status, 500);
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes('leak-me-123'), 'internal error text must never reach clients');
    assert.equal((r.body as { error: string }).error, 'Internal server error.');
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('register/usage validation failures keep designed messages (no stack traces)', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const token = await registerSession(baseUrl);
    const r = await request(baseUrl, '/api/usage', {
      method: 'POST',
      body: { user_id: 'x', model: 'm', input_tokens: -5, output_tokens: 1, agent_turns: 1 },
      token,
    });
    assert.equal(r.status, 400);
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes('node:internal'), 'no stack-trace artifacts');
    assert.ok(!text.includes('  at '), 'no stack frames');
  } finally {
    setDbForTests(null);
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Logging scrub (observability must never leak secrets)
// ---------------------------------------------------------------------------

test('scrubForLogs redacts keys, connection strings and bearer tokens', () => {
  const scrubbed = scrubForLogs(
    'key=gsk_abc123abc123abc123abc123abc123 url=postgresql://user:pass@host/db tok=Bearer aaaa1111bbbb2222cccc3333dddd4444',
  );
  assert.ok(!scrubbed.includes('gsk_abc123'), 'groq key redacted');
  assert.ok(!scrubbed.includes('postgresql://user:pass'), 'database URL redacted');
  assert.ok(!scrubbed.includes('aaaa1111bbbb2222'), 'bearer token redacted');
});

test('scrubForLogs truncates long detail to a bounded length', () => {
  const long = 'x'.repeat(10_000);
  const scrubbed = scrubForLogs(long);
  assert.ok(scrubbed.length <= 400);
});

// ---------------------------------------------------------------------------
// API-scope rate limiting (usage) with Retry-After
// ---------------------------------------------------------------------------

test('usage endpoint rate-limits with 429 and Retry-After', async () => {
  process.env.ZEESH_API_RATE_LIMIT_MAX = '3';
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  resetRateLimiters();
  const { server, baseUrl } = await startServer();
  try {
    const token = await registerSession(baseUrl, 'ratelimit@example.com');
    const report = { user_id: 'x', model: 'm', input_tokens: 1, output_tokens: 1, agent_turns: 1 };
    let lastStatus = 0;
    let lastRetryAfter: string | null = null;
    for (let i = 0; i < 6; i += 1) {
      const res = await fetch(baseUrl + '/api/usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(report),
      });
      lastStatus = res.status;
      lastRetryAfter = res.headers.get('retry-after');
    }
    assert.equal(lastStatus, 429);
    assert.ok(Number(lastRetryAfter) >= 1, 'Retry-After header present');
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('ApiClient surfaces 429 rate limits with retryAfterSeconds', async () => {
  process.env.ZEESH_API_RATE_LIMIT_MAX = '1';
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  resetRateLimiters();
  const { server, baseUrl } = await startServer();
  try {
    const client = new ApiClient(baseUrl);
    const session = await client.register('cli-ratelimit@example.com', 'hunter2-strong');
    const report = {
      client_run_id: 'e2e-ratelimit-1',
      user_id: 'x',
      model: 'm',
      status: 'done' as const,
      agent_turns: 1,
      tool_calls: 1,
      input_tokens: 1,
      output_tokens: 1,
    };
    await client.reportUsage(session.token, report);
    let hit429: ApiError | null = null;
    try {
      await client.reportUsage(session.token, report);
    } catch (err) {
      if (err instanceof ApiError) hit429 = err;
    }
    assert.ok(hit429, 'second call hits the API rate limit');
    assert.equal(hit429?.status, 429);
    assert.ok((hit429?.retryAfterSeconds ?? 0) >= 1);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Provider errors stay generic (Milestone 12 hardening)
// ---------------------------------------------------------------------------

test('POST /api/provider returns a generic error when the provider key is missing', async () => {
  delete process.env.GROQ_API_KEY;
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const token = await registerSession(baseUrl);
    const r = await request(baseUrl, '/api/provider', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }] },
      token,
    });
    assert.equal(r.status, 503);
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes('gsk_'), 'no key material in the response');
    assert.ok(!text.includes('undefined'), 'no stack-trace artifacts');
  } finally {
    setDbForTests(null);
    server.close();
  }
});
