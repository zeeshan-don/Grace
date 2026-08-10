/**
 * GRACE FREE daily session system (Milestone 13) tests.
 *
 * Covers the required scenarios:
 *   - first session (auto-started by the first inference request)
 *   - session expiry (expired session auto-advances to the next)
 *   - second session
 *   - six-session daily limit (7th request → 429 daily_limit_exhausted)
 *   - daily reset (new UTC day → quota refills)
 *   - multiple requests within a session (one session, no double-start)
 *   - concurrent requests (unique constraint + retry ⇒ no over-counting)
 *   - unauthenticated access (401 on /api/usage and /api/provider)
 *
 * The backend is the single source of truth: tests mutate the *database* rows
 * (memory db) to simulate the passage of time — never client state.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import { setDbForTests } from '../src/api/db.ts';
import {
  DEFAULT_SESSION_DURATION_MS,
  FreeSessionService,
  secondsUntilUtcMidnight,
  utcDay,
  type DailySessionState,
} from '../src/api/freeSessions.ts';
import { resetRateLimiters } from '../src/api/rateLimit.ts';
import { createApiServer } from '../src/api/server.ts';
import { sessionStatusDisplay } from '../src/cli/commands.ts';
import { bannerFreePlanLine, formatCountdown, sessionRolloverNote, sessionSecondsLeft, sessionStatusLine } from '../src/cli/freePlan.ts';
import { GroqProvider } from '../src/providers/groq.ts';
import { createMemoryDb, type MemFreeSession, type MemoryDb } from './helpers/memoryDb.ts';

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.GROQ_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.ZEESH_SESSIONS_PER_DAY;
  delete process.env.ZEESH_SESSION_DURATION_MINUTES;
  delete process.env.ZEESH_AUTH_RATE_LIMIT_MAX;
  delete process.env.ZEESH_API_RATE_LIMIT_MAX;
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
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(baseUrl + path, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

/** Register a user against a memory-backed server; returns { token, userId }. */
async function registerSession(baseUrl: string, mem: MemoryDb, email = 'dev@example.com'): Promise<{ token: string; userId: string }> {
  const { status, body } = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { email, password: 'hunter2-strong' },
  });
  assert.equal(status, 201);
  return { token: body.token as string, userId: mem.users[0]!.id };
}

/** POST /api/provider — one inference request inside the free-plan gate. */
function chat(
  baseUrl: string,
  token: string,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  return request(baseUrl, '/api/provider', {
    method: 'POST',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    token,
  });
}

/** GET /api/usage — the session summary endpoint. */
function usageState(baseUrl: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return request(baseUrl, '/api/usage?limit=5', { token });
}

/**
 * Simulate the passage of time: every session row for the user is moved into
 * the past (expires_at before now), so the server sees them as expired.
 * Returns the rows so tests can also rewrite their day bucket (daily reset).
 */
function expireAll(mem: MemoryDb, userId: string): MemFreeSession[] {
  const past = new Date(Date.now() - 1000).toISOString();
  for (const s of mem.freeSessions) {
    if (s.user_id === userId) s.expires_at = past;
  }
  return mem.freeSessions.filter((s) => s.user_id === userId);
}

/**
 * Stub the provider chat so no network/key is needed. GROQ_API_KEY must be
 * set for createServerProvider; NVIDIA_API_KEY is blanked so the real
 * environment key cannot build a live NVIDIA leg in the router chain.
 */
async function withStubbedChat<T>(fn: () => Promise<T>): Promise<T> {
  process.env.GROQ_API_KEY = 'gsk_fake_key_for_tests';
  const savedNvidia = process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  const original = GroqProvider.prototype.chat;
  GroqProvider.prototype.chat = (async () => ({
    content: 'ok',
    toolCalls: [],
    finishReason: 'stop',
  })) as typeof GroqProvider.prototype.chat;
  try {
    return await fn();
  } finally {
    GroqProvider.prototype.chat = original;
    if (savedNvidia !== undefined) process.env.NVIDIA_API_KEY = savedNvidia;
    else delete process.env.NVIDIA_API_KEY;
    delete process.env.GROQ_API_KEY;
  }
}

/** Cast a raw response body to the daily session state shape. */
function stateOf(body: Record<string, unknown>): DailySessionState {
  return body as unknown as DailySessionState;
}

// ---------------------------------------------------------------------------
// Service-level unit tests
// ---------------------------------------------------------------------------

test('utcDay uses the UTC date bucket (server-authoritative day boundary)', () => {
  assert.equal(utcDay(new Date('2026-08-10T23:59:59.999Z')), '2026-08-10');
  assert.equal(utcDay(new Date('2026-08-11T00:00:00.000Z')), '2026-08-11');
});

test('secondsUntilUtcMidnight counts down to 00:00 UTC', () => {
  const noon = new Date('2026-08-10T12:00:00.000Z');
  assert.equal(secondsUntilUtcMidnight(noon), 12 * 3600);
  const almostMidnight = new Date('2026-08-10T23:59:59.500Z');
  assert.equal(secondsUntilUtcMidnight(almostMidnight), 1);
});

test('getState computes used/remaining/current from rows without mutating', async () => {
  const mem = createMemoryDb();
  const fixed = new Date('2026-08-10T12:00:00.000Z');
  // Realistic sequential sessions: each starts after the previous expired.
  // Session 1: fully expired → its whole hour counts.
  mem.freeSessions.push({
    id: 's1',
    user_id: 'u-1',
    day: '2026-08-10',
    session_number: 1,
    started_at: '2026-08-10T10:00:00.000Z',
    expires_at: '2026-08-10T11:00:00.000Z',
    ended_at: '2026-08-10T11:00:00.000Z',
  });
  // Session 2: expired exactly at 12:00 → its whole hour counts.
  mem.freeSessions.push({
    id: 's2',
    user_id: 'u-1',
    day: '2026-08-10',
    session_number: 2,
    started_at: '2026-08-10T11:00:00.000Z',
    expires_at: '2026-08-10T12:00:00.000Z',
    ended_at: '2026-08-10T12:00:00.000Z',
  });
  // Session 3: just started (12:00 → 13:00) → the only active one.
  mem.freeSessions.push({
    id: 's3',
    user_id: 'u-1',
    day: '2026-08-10',
    session_number: 3,
    started_at: '2026-08-10T12:00:00.000Z',
    expires_at: '2026-08-10T13:00:00.000Z',
    ended_at: null,
  });

  const svc = new FreeSessionService(mem.db, { now: () => fixed });
  const state = await svc.getState('u-1');
  assert.equal(state.sessionsUsed, 3);
  assert.equal(state.sessionsRemaining, 3);
  assert.equal(state.currentSession, 3, 'only the active session is current');
  assert.equal(state.sessionExpiresAt, '2026-08-10T13:00:00.000Z');
  assert.equal(state.dailyUsedSeconds, 3600 + 3600 + 0, 'expired sessions count in full');
  assert.equal(state.dailyLimitSeconds, 6 * 3600);
  assert.equal(mem.freeSessions.length, 3, 'getState must not mutate');
});

test('getState caps dailyUsedSeconds at the daily limit and hides an expired current session', async () => {
  const mem = createMemoryDb();
  const fixed = new Date('2026-08-10T12:00:00.000Z');
  for (let i = 1; i <= 6; i += 1) {
    mem.freeSessions.push({
      id: `s${i}`,
      user_id: 'u-1',
      day: '2026-08-10',
      session_number: i,
      started_at: '2026-08-10T00:00:00.000Z',
      expires_at: '2026-08-10T01:00:00.000Z', // all expired
      ended_at: null,
    });
  }
  const svc = new FreeSessionService(mem.db, { now: () => fixed });
  const state = await svc.getState('u-1');
  assert.equal(state.sessionsUsed, 6);
  assert.equal(state.sessionsRemaining, 0);
  assert.equal(state.currentSession, null);
  assert.equal(state.dailyUsedSeconds, 6 * 3600);
});

test('ensureActiveSession starts the first session and reuses an active one', async () => {
  const mem = createMemoryDb();
  const svc = new FreeSessionService(mem.db);
  const gate1 = await svc.ensureActiveSession('u-1');
  assert.equal(gate1.ok, true);
  if (gate1.ok) {
    assert.equal(gate1.startedNew, true);
    assert.equal(gate1.state.currentSession, 1);
    assert.equal(gate1.state.sessionsRemaining, 5);
  }
  const gate2 = await svc.ensureActiveSession('u-1');
  assert.equal(gate2.ok, true);
  if (gate2.ok) {
    assert.equal(gate2.startedNew, false, 'active session must not be double-started');
    assert.equal(gate2.state.currentSession, 1);
  }
  assert.equal(mem.freeSessions.length, 1, 'exactly one session row');
});

test('ensureActiveSession auto-advances when the current session expired', async () => {
  const mem = createMemoryDb();
  const svc = new FreeSessionService(mem.db);
  await svc.ensureActiveSession('u-1');
  expireAll(mem, 'u-1');
  const gate = await svc.ensureActiveSession('u-1');
  assert.equal(gate.ok, true);
  if (gate.ok) {
    assert.equal(gate.startedNew, true);
    assert.equal(gate.state.currentSession, 2);
    assert.equal(gate.state.sessionsUsed, 2);
  }
  // The replaced session was marked ended (lazy server-side "end").
  assert.ok(mem.freeSessions.find((s) => s.session_number === 1)?.ended_at, 'session 1 ended_at set');
});

test('ensureActiveSession refuses when all 6 sessions are used', async () => {
  const mem = createMemoryDb();
  const svc = new FreeSessionService(mem.db);
  for (let i = 1; i <= 6; i += 1) {
    const g = await svc.ensureActiveSession('u-1');
    assert.equal(g.ok, true, `session ${i} starts`);
    expireAll(mem, 'u-1');
  }
  const gate = await svc.ensureActiveSession('u-1');
  assert.equal(gate.ok, false);
  if (!gate.ok) {
    assert.equal(gate.code, 'daily_limit_exhausted');
    assert.equal(gate.status, 429);
  }
  assert.equal(mem.freeSessions.length, 6);
});

test('ensureActiveSession retries past a concurrent unique-violation', async () => {
  const mem = createMemoryDb();
  const svc = new FreeSessionService(mem.db);
  // Seed session 1, then make the first INSERT attempt of "session 2" collide.
  await svc.ensureActiveSession('u-1');
  expireAll(mem, 'u-1');
  mem.freeSessions.push({
    id: 's2',
    user_id: 'u-1',
    day: utcDay(new Date()),
    session_number: 2,
    started_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ended_at: null,
  });
  expireAll(mem, 'u-1'); // now the next free number is 3, but a race picked 2 first
  const gate = await svc.ensureActiveSession('u-1');
  assert.equal(gate.ok, true);
  if (gate.ok) assert.equal(gate.state.currentSession, 3);
});

// ---------------------------------------------------------------------------
// Handler-level integration tests (real server + memory db)
// ---------------------------------------------------------------------------

test('first session: /api/usage starts empty; the first inference starts session 1', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const { token } = await registerSession(baseUrl, mem);
    const before = await usageState(baseUrl, token);
    assert.equal(before.status, 200);
    assert.equal(stateOf(before.body).sessionsUsed, 0);
    assert.equal(stateOf(before.body).sessionsRemaining, 6);
    assert.equal(stateOf(before.body).currentSession, null);
    assert.equal(stateOf(before.body).dailyLimitSeconds, 6 * 3600);

    await withStubbedChat(async () => {
      const r = await chat(baseUrl, token);
      assert.equal(r.status, 200);
      const session = (r.body.session ?? {}) as DailySessionState & { startedNew?: boolean };
      assert.equal(session.currentSession, 1);
      assert.equal(session.startedNew, true);
      assert.equal(session.sessionsUsed, 1);
      assert.ok(session.sessionExpiresAt, 'expiry timestamp returned');
    });

    const after = await usageState(baseUrl, token);
    assert.equal(stateOf(after.body).sessionsUsed, 1);
    assert.equal(stateOf(after.body).sessionsRemaining, 5);
    assert.equal(stateOf(after.body).currentSession, 1);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('session expiry: an expired session auto-advances to the second session', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const { token, userId } = await registerSession(baseUrl, mem);
    await withStubbedChat(async () => {
      await chat(baseUrl, token); // session 1
      assert.equal(mem.freeSessions.length, 1);
      expireAll(mem, userId); // time passes — session 1 expires
      const r = await chat(baseUrl, token); // next request
      assert.equal(r.status, 200);
      const session = (r.body.session ?? {}) as DailySessionState & { startedNew?: boolean };
      assert.equal(session.currentSession, 2, 'second session started');
      assert.equal(session.startedNew, true);
      assert.equal(session.sessionsUsed, 2);
      assert.equal(mem.freeSessions.length, 2, 'exactly two session rows');
      assert.ok(mem.freeSessions.find((s) => s.session_number === 1)?.ended_at, 'expired session ended');
    });
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('six-session limit: the 7th inference of the day is refused with 429 daily_limit_exhausted', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const { token, userId } = await registerSession(baseUrl, mem);
    await withStubbedChat(async () => {
      for (let n = 1; n <= 6; n += 1) {
        expireAll(mem, userId);
        const r = await chat(baseUrl, token);
        assert.equal(r.status, 200, `session ${n} starts`);
        const session = (r.body.session ?? {}) as DailySessionState & { startedNew?: boolean };
        assert.equal(session.currentSession, n);
        assert.equal(session.sessionsUsed, n);
      }
      expireAll(mem, userId);
      const blocked = await chat(baseUrl, token);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.code, 'daily_limit_exhausted');
      assert.match(String(blocked.body.error), /all 6 free sessions/);
      assert.ok(Number(blocked.headers.get('retry-after')) >= 1, 'Retry-After points at the next day');
      assert.equal(mem.freeSessions.length, 6, 'no 7th session row created');
      // The rejection is self-describing: it carries the current state.
      const rejectedState = blocked.body.session as DailySessionState;
      assert.equal(rejectedState.sessionsUsed, 6);
      assert.equal(rejectedState.sessionsRemaining, 0);
    });
    const after = await usageState(baseUrl, token);
    assert.equal(stateOf(after.body).sessionsUsed, 6);
    assert.equal(stateOf(after.body).sessionsRemaining, 0);
    assert.equal(stateOf(after.body).currentSession, null);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('daily reset: a new UTC day refills the quota', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const { token, userId } = await registerSession(baseUrl, mem);
    await withStubbedChat(async () => {
      for (let n = 1; n <= 6; n += 1) {
        expireAll(mem, userId);
        const r = await chat(baseUrl, token);
        assert.equal(r.status, 200);
      }
      expireAll(mem, userId);
      assert.equal((await chat(baseUrl, token)).status, 429, 'quota exhausted');

      // The next day: the previous day's rows still exist but are not counted.
      for (const s of mem.freeSessions) if (s.user_id === userId) s.day = '2000-01-01';

      const r = await chat(baseUrl, token);
      assert.equal(r.status, 200, 'new day → inference allowed again');
      const session = (r.body.session ?? {}) as DailySessionState & { startedNew?: boolean };
      assert.equal(session.currentSession, 1, 'fresh session 1 of the new day');
      assert.equal(session.sessionsUsed, 1);
    });
    const after = await usageState(baseUrl, token);
    assert.equal(stateOf(after.body).sessionsUsed, 1);
    assert.equal(stateOf(after.body).sessionsRemaining, 5);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('multiple requests within a session share one session (no double-start)', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const { token } = await registerSession(baseUrl, mem);
    await withStubbedChat(async () => {
      for (let i = 0; i < 3; i += 1) {
        const r = await chat(baseUrl, token);
        assert.equal(r.status, 200);
        const session = (r.body.session ?? {}) as DailySessionState & { startedNew?: boolean };
        assert.equal(session.currentSession, 1, 'stays in session 1');
        if (i === 0) assert.equal(session.startedNew, true);
        else assert.equal(session.startedNew, false);
      }
    });
    assert.equal(mem.freeSessions.length, 1, 'exactly one session for three requests');
    const state = await usageState(baseUrl, token);
    assert.equal(stateOf(state.body).sessionsUsed, 1);
    assert.ok(stateOf(state.body).dailyUsedSeconds >= 0);
    assert.equal(stateOf(state.body).dailyLimitSeconds, 6 * 3600);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('concurrent starts never exceed the limit and never duplicate (service level)', async () => {
  process.env.ZEESH_SESSIONS_PER_DAY = '4';
  const mem = createMemoryDb();
  const svc = new FreeSessionService(mem.db);
  // True race: all four calls interleave at the same await points. Whichever
  // one inserts first wins session 1; the losers either retry past a UNIQUE
  // violation (23505) or join the just-started active session — so every call
  // is served and no number is ever duplicated or fabricated.
  const gates = await Promise.all(Array.from({ length: 4 }, () => svc.ensureActiveSession('u-1')));
  for (const gate of gates) assert.equal(gate.ok, true, 'every concurrent start is served');
  const numbers = mem.freeSessions.map((s) => s.session_number).sort((a, b) => a - b);
  assert.ok(numbers.length >= 1 && numbers.length <= 4, 'sessions within the daily cap');
  assert.equal(new Set(numbers).size, numbers.length, 'no duplicate session numbers');

  // Fill the rest of the day sequentially, then confirm refusal — concurrent
  // usage can never open more than the daily cap.
  for (let i = numbers.length; i < 4; i += 1) {
    expireAll(mem, 'u-1');
    const gate = await svc.ensureActiveSession('u-1');
    assert.equal(gate.ok, true);
  }
  expireAll(mem, 'u-1');
  const fifth = await svc.ensureActiveSession('u-1');
  assert.equal(fifth.ok, false);
  if (!fifth.ok) {
    assert.equal(fifth.code, 'daily_limit_exhausted');
    assert.equal(fifth.status, 429);
  }
  assert.equal(mem.freeSessions.length, 4, 'no 5th session row');
});

test('concurrent HTTP requests are safe (invariants hold regardless of serialization)', async () => {
  process.env.ZEESH_SESSIONS_PER_DAY = '4';
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const { token, userId } = await registerSession(baseUrl, mem);
    await withStubbedChat(async () => {
      const results = await Promise.all(
        Array.from({ length: 4 }, () => chat(baseUrl, token)),
      );
      for (const r of results) {
        // Served inside an existing session, or a freshly started one — never
        // a fabricated/duplicate session and never an error.
        assert.equal(r.status, 200, 'concurrent inference requests are served');
      }
      const numbers = mem.freeSessions
        .filter((s) => s.user_id === userId)
        .map((s) => s.session_number)
        .sort((a, b) => a - b);
      assert.ok(numbers.length >= 1 && numbers.length <= 4, 'sessions within the daily cap');
      assert.equal(new Set(numbers).size, numbers.length, 'no duplicate session numbers');
    });
    const state = await usageState(baseUrl, token);
    assert.equal(stateOf(state.body).sessionsRemaining, 4 - mem.freeSessions.filter((s) => s.user_id === userId).length);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('GET /api/session/status reports the active session + router provider/model', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const { token } = await registerSession(baseUrl, mem);
    const before = await request(baseUrl, '/api/session/status', { token });
    assert.equal(before.status, 200);
    const s0 = before.body.session as Record<string, unknown>;
    assert.equal(s0.status, 'none');
    assert.equal(s0.id, null);
    assert.equal(s0.sessionsUsed, 0);
    assert.equal(s0.sessionsRemaining, 6);

    await withStubbedChat(async () => {
      await chat(baseUrl, token); // starts session 1
    });

    const after = await request(baseUrl, '/api/session/status', { token });
    assert.equal(after.status, 200);
    const s1 = after.body.session as Record<string, unknown>;
    assert.equal(s1.status, 'active');
    assert.ok(s1.id, 'active session row id present');
    assert.equal(s1.currentSession, 1);
    assert.equal(s1.sessionsRemaining, 5);
    assert.ok(s1.expires_at, 'expiry timestamp present');
    assert.equal(typeof s1.provider, 'string', 'router primary provider present');
    assert.equal(typeof s1.model, 'string', 'router model present');
    assert.equal(s1.status, 'active');
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('GET /api/session/status reports expired after natural expiry, ended after explicit end', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const { token, userId } = await registerSession(baseUrl, mem);
    await withStubbedChat(async () => {
      await chat(baseUrl, token); // session 1 active

      // Natural expiry: the session runs out → status is 'expired', not 'ended'.
      expireAll(mem, userId);
      const expired = await request(baseUrl, '/api/session/status', { token });
      assert.equal(expired.status, 200);
      assert.equal((expired.body.session as Record<string, unknown>).status, 'expired');

      // A fresh session, explicitly ended → status is 'ended'.
      await chat(baseUrl, token); // starts session 2
      const ended = await request(baseUrl, '/api/session/end', { method: 'POST', token });
      assert.equal(ended.status, 200);
      assert.equal((ended.body.session as Record<string, unknown>).status, 'ended');

      const after = await request(baseUrl, '/api/session/status', { token });
      assert.equal(after.status, 200);
      assert.equal(
        (after.body.session as Record<string, unknown>).status,
        'ended',
        'status endpoint distinguishes an explicitly ended session from an expired one',
      );
      assert.equal((after.body.session as Record<string, unknown>).currentSession, null);
    });
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('GET /api/session/status is read-only (never starts a session)', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const { token } = await registerSession(baseUrl, mem);
    await request(baseUrl, '/api/session/status', { token });
    await request(baseUrl, '/api/session/status', { token });
    assert.equal(mem.freeSessions.length, 0, 'status never auto-starts a session');
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('POST /api/session/end ends the active session; the next request starts a fresh one', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const { token, userId } = await registerSession(baseUrl, mem);
    await withStubbedChat(async () => {
      await chat(baseUrl, token); // session 1 active
    });
    assert.equal(mem.freeSessions.length, 1);

    const ended = await request(baseUrl, '/api/session/end', { method: 'POST', token });
    assert.equal(ended.status, 200);
    const s = ended.body.session as Record<string, unknown>;
    assert.equal(s.status, 'ended');
    assert.ok(
      mem.freeSessions.find((x) => x.user_id === userId && x.session_number === 1)?.ended_at,
      'the active row was marked ended server-side',
    );
    assert.equal(mem.freeSessions.length, 1, 'ending never creates a row');

    // The next inference starts the next session — ending is explicit, not a refund.
    await withStubbedChat(async () => {
      const r = await chat(baseUrl, token);
      assert.equal(r.status, 200);
      const session = (r.body.session ?? {}) as DailySessionState & { startedNew?: boolean };
      assert.equal(session.currentSession, 2, 'a fresh session starts after an explicit end');
      assert.equal(session.startedNew, true);
    });
    assert.equal(mem.freeSessions.length, 2);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('session status/end require authentication (401)', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    assert.equal((await request(baseUrl, '/api/session/status', {})).status, 401);
    assert.equal((await request(baseUrl, '/api/session/end', { method: 'POST' })).status, 401);
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('unauthenticated access to usage and provider is refused with 401', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const usageNoToken = await usageState(baseUrl, '');
    assert.equal(usageNoToken.status, 401);
    const providerNoToken = await request(baseUrl, '/api/provider', {
      method: 'POST',
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(providerNoToken.status, 401);
    const badToken = await usageState(baseUrl, 'not-a-real-token');
    assert.equal(badToken.status, 401);
    assert.equal(mem.freeSessions.length, 0, 'no session started for unauthenticated callers');
  } finally {
    setDbForTests(null);
    server.close();
  }
});

// ---------------------------------------------------------------------------
// CLI display helpers (pure rendering of server state)
// ---------------------------------------------------------------------------

const sampleState: DailySessionState = {
  sessionsUsed: 2,
  sessionsRemaining: 4,
  currentSession: 2,
  sessionStartedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  sessionExpiresAt: new Date(Date.now() + 55 * 60_000).toISOString(),
  dailyUsedSeconds: 600,
  dailyLimitSeconds: 21_600,
};

test('formatCountdown renders compact mm ss from seconds', () => {
  assert.equal(formatCountdown(2871), '47m 51s');
  assert.equal(formatCountdown(59), '59s');
  assert.equal(formatCountdown(0), 'expired');
  assert.equal(formatCountdown(null), '');
});

test('sessionSecondsLeft computes remaining display time from expiresAt', () => {
  const left = sessionSecondsLeft(sampleState.sessionExpiresAt);
  assert.ok(left !== null && left > 50 * 60 && left <= 55 * 60, 'roughly 55 minutes left');
  assert.equal(sessionSecondsLeft(null), null);
  assert.equal(sessionSecondsLeft('garbage'), null);
});

test('sessionStatusLine shows session, time remaining and today\'s usage', () => {
  const line = sessionStatusLine(sampleState);
  assert.match(line, /Session 2 \/ 6/);
  assert.match(line, /left/);
  assert.match(line, /used today/);
  assert.match(line, /10m \/ 6h used today/);
  assert.equal(sessionStatusLine(null), '', 'no state → nothing to print');
});

test('sessionRolloverNote announces the fresh session; banner line degrades', () => {
  const note = sessionRolloverNote(sampleState);
  assert.match(note, /Session 2 of 6 started/);

  const banner = bannerFreePlanLine(sampleState);
  assert.match(banner, /Session 2\/6/);

  const exhausted: DailySessionState = { ...sampleState, sessionsUsed: 6, sessionsRemaining: 0, currentSession: null, sessionExpiresAt: null, sessionStartedAt: null };
  assert.match(bannerFreePlanLine(exhausted), /all 6 sessions used/);

  const fresh: DailySessionState = { ...sampleState, sessionsUsed: 0, sessionsRemaining: 6, currentSession: null, sessionExpiresAt: null, sessionStartedAt: null };
  assert.match(bannerFreePlanLine(fresh), /6 sessions remaining today/);
  assert.equal(bannerFreePlanLine(null), '', 'not logged in → no banner row');
});

test('sessionStatusDisplay renders every server state gracefully', () => {
  assert.match(sessionStatusDisplay('active'), /active/);
  assert.match(sessionStatusDisplay('expired'), /fresh session/);
  assert.match(sessionStatusDisplay('ended'), /fresh session/);
  assert.match(sessionStatusDisplay('none'), /no session yet/);
  assert.match(sessionStatusDisplay('rate_limited'), /rate limited/);
  assert.match(sessionStatusDisplay('model_unavailable'), /fall back/);
  assert.match(sessionStatusDisplay('banned'), /account disabled/);
  assert.match(sessionStatusDisplay('unauthorized'), /grace login/);
  // Unknown future states must not crash the CLI.
  assert.equal(sessionStatusDisplay('something_new'), 'something_new');
});

test('session duration is configurable via env (60 minutes by default)', async () => {
  const mem = createMemoryDb();
  const svc = new FreeSessionService(mem.db);
  await svc.ensureActiveSession('u-1');
  const row = mem.freeSessions[0]!;
  const started = new Date(row.started_at).getTime();
  const expires = new Date(row.expires_at).getTime();
  assert.equal(expires - started, DEFAULT_SESSION_DURATION_MS, 'default session is 60 minutes');

  process.env.ZEESH_SESSION_DURATION_MINUTES = '30';
  expireAll(mem, 'u-1'); // the first session must be expired before the next starts
  const svc30 = new FreeSessionService(mem.db);
  await svc30.ensureActiveSession('u-1');
  const row2 = mem.freeSessions.find((s) => s.session_number === 2)!;
  assert.equal(
    new Date(row2.expires_at).getTime() - new Date(row2.started_at).getTime(),
    30 * 60_000,
    'env override shortens sessions (tests/ops tuning)',
  );
});
