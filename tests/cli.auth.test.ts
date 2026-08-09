import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { setDbForTests } from '../src/api/db.ts';
import { resetRateLimiters } from '../src/api/rateLimit.ts';
import { createApiServer } from '../src/api/server.ts';
import { ApiClient, ApiError } from '../src/auth/client.ts';
import {
  buildUsageReport,
  reportRunUsage,
  sendUsageReport,
  type RunReportInput,
} from '../src/auth/reporting.ts';
import {
  clearSession,
  loadSession,
  saveSession,
  sessionExpired,
  type StoredSession,
} from '../src/auth/session.ts';
import { createMemoryDb } from './helpers/memoryDb.ts';

const tmp = mkdtempSync(join(tmpdir(), 'zeesh-auth-test-'));

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
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

/** A valid StoredSession pointing at a live memory-backed server. */
async function liveSession(baseUrl: string): Promise<StoredSession> {
  const client = new ApiClient(baseUrl);
  const result = await client.register('cli@example.com', 'hunter2-strong');
  return {
    apiUrl: baseUrl,
    token: result.token,
    user: { id: result.user.id, email: result.user.email, displayName: result.user.display_name },
    expiresAt: result.expires_at,
    createdAt: new Date().toISOString(),
  };
}

function sampleRunInput(): RunReportInput {
  return {
    prompt: 'Fix the login bug',
    model: 'openai/gpt-oss-120b',
    projectType: 'node',
    iterations: 4,
    toolCalls: 12,
    usage: { inputTokens: 4520, outputTokens: 890, totalTokens: 5410 },
    executionTimeMs: 31_240,
  };
}

// ---------------------------------------------------------------------------
// Local session persistence
// ---------------------------------------------------------------------------

test('save/load/clear session round-trips through a 0600 file', () => {
  const path = join(tmp, 'session-1.json');
  const session: StoredSession = {
    apiUrl: 'http://localhost:8787',
    token: 'a'.repeat(64),
    user: { id: 'u-1', email: 'dev@example.com', displayName: 'Dev' },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: new Date().toISOString(),
  };
  saveSession(session, path);

  const loaded = loadSession(path);
  assert.deepEqual(loaded, session);
  assert.ok(!sessionExpired(loaded!));

  clearSession(path);
  assert.equal(loadSession(path), null);
});

test('loadSession returns null for missing/corrupt files', () => {
  assert.equal(loadSession(join(tmp, 'nope.json')), null);
  const corrupt = join(tmp, 'corrupt.json');
  saveSession(
    { apiUrl: 'x', token: 'y'.repeat(64), user: { id: 'u', email: 'e', displayName: null }, expiresAt: '', createdAt: '' },
    corrupt,
  );
  rmSync(corrupt);
  // Write invalid JSON directly.
  writeFileSync(corrupt, '{ not json', 'utf8');
  assert.equal(loadSession(corrupt), null);
});

test('sessionExpired reflects the expiry timestamp', () => {
  const past: StoredSession = {
    apiUrl: 'http://x',
    token: 't'.repeat(64),
    user: { id: 'u', email: 'e', displayName: null },
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    createdAt: '',
  };
  assert.ok(sessionExpired(past));
  const future: StoredSession = { ...past, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  assert.ok(!sessionExpired(future));
});

// ---------------------------------------------------------------------------
// ApiClient against a live server
// ---------------------------------------------------------------------------

test('ApiClient register → login → me → logout round-trip', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const client = new ApiClient(baseUrl);
    const reg = await client.register('roundtrip@example.com', 'hunter2-strong', 'Round Trip');
    assert.equal(reg.user.email, 'roundtrip@example.com');
    assert.ok(reg.token);

    const me = await client.me(reg.token);
    assert.equal(me.email, 'roundtrip@example.com');

    const login = await client.login('roundtrip@example.com', 'hunter2-strong');
    assert.ok(login.token);
    const me2 = await client.me(login.token);
    assert.equal(me2.email, 'roundtrip@example.com');

    await client.logout(login.token);
    await assert.rejects(() => client.me(login.token), (err: unknown) => err instanceof ApiError && err.status === 401);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('ApiClient surfaces 401 for bad credentials as ApiError', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const client = new ApiClient(baseUrl);
    await assert.rejects(
      () => client.login('nobody@example.com', 'wrong-password'),
      (err: unknown) => err instanceof ApiError && err.status === 401,
    );
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('ApiClient fails fast with ApiError(0) when the backend is unreachable', async () => {
  const client = new ApiClient('http://127.0.0.1:1', 2000); // nothing listens on port 1
  await assert.rejects(
    () => client.login('a@b.com', 'password'),
    (err: unknown) => err instanceof ApiError && err.status === 0,
  );
});

// ---------------------------------------------------------------------------
// Usage reporting
// ---------------------------------------------------------------------------

test('buildUsageReport produces the full M11 payload', () => {
  const report = buildUsageReport(sampleRunInput());
  assert.ok(report);
  assert.equal(report!.model, 'openai/gpt-oss-120b');
  assert.equal(report!.input_tokens, 4520);
  assert.equal(report!.output_tokens, 890);
  assert.equal(report!.agent_turns, 4);
  assert.equal(report!.tool_calls, 12);
  assert.equal(report!.execution_time_ms, 31_240);
  assert.equal(report!.project_type, 'node');
  assert.equal(report!.status, 'done');
  assert.match(report!.client_run_id, /^[0-9a-f-]{36}$/);
});

test('buildUsageReport returns null when there is no usage', () => {
  const input = sampleRunInput();
  input.usage = undefined;
  assert.equal(buildUsageReport(input), null);
});

test('sendUsageReport records a run against the backend (reported)', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const session = await liveSession(baseUrl);
    const outcome = await sendUsageReport(session, buildUsageReport(sampleRunInput())!);
    assert.equal(outcome, 'reported');
    assert.equal(mem.runs.length, 1);
    assert.equal(mem.runs[0]?.user_id, session.user.id);
    assert.equal(mem.usageRows.length, 1);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('reportRunUsage never throws when the backend is down (failed)', async () => {
  const session: StoredSession = {
    apiUrl: 'http://127.0.0.1:1', // unreachable
    token: 't'.repeat(64),
    user: { id: 'u-1', email: 'dev@example.com', displayName: null },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: new Date().toISOString(),
  };
  const outcome = await reportRunUsage(sampleRunInput(), session, () => {});
  assert.equal(outcome, 'failed');
});

test('reportRunUsage skips when not logged in or when the session expired', async () => {
  // Not logged in.
  assert.equal(await reportRunUsage(sampleRunInput(), null), 'skipped');

  // Expired session → skipped and cleared.
  const expired: StoredSession = {
    apiUrl: 'http://127.0.0.1:1',
    token: 't'.repeat(64),
    user: { id: 'u-1', email: 'dev@example.com', displayName: null },
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    createdAt: '',
  };
  let cleared = false;
  const outcome = await reportRunUsage(sampleRunInput(), expired, () => {
    cleared = true;
  });
  assert.equal(outcome, 'skipped');
  assert.ok(cleared, 'expired sessions are cleared locally');
});

test('reportRunUsage reports through the real backend when logged in', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const session = await liveSession(baseUrl);
    const outcome = await reportRunUsage(sampleRunInput(), session, () => {});
    assert.equal(outcome, 'reported');
    assert.equal(mem.runs.length, 1);
  } finally {
    setDbForTests(null);
    server.close();
  }
});
