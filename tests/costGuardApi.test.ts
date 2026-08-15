/**
 * End-to-end cost guard tests through the real API server (memory db).
 *
 * Verifies the ₹20/day ceiling is enforced server-side over HTTP:
 *   - a normal request settles actual spend and records ai_usage,
 *   - an exhausted budget is refused with a friendly, cost-free message and
 *     consumes NO session slot,
 *   - concurrent requests can never push a user over the ceiling.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import { setDbForTests } from '../src/api/db.ts';
import { resetRateLimiters } from '../src/api/rateLimit.ts';
import { createApiServer } from '../src/api/server.ts';
import { inrToUsdMicros } from '../src/costs/money.ts';
import { GroqProvider } from '../src/providers/groq.ts';
import { estimateTokens } from '../src/util/text.ts';
import { createMemoryDb } from './helpers/memoryDb.ts';

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.GROQ_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.MINIMAX_API_KEY;
  delete process.env.ZEESH_DAILY_COST_LIMIT_INR;
  delete process.env.ZEESH_INR_PER_USD;
  delete process.env.ZEESH_GLOBAL_DAILY_COST_LIMIT_INR;
  delete process.env.ZEESH_GLOBAL_MONTHLY_COST_LIMIT_INR;
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
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(baseUrl + path, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function registerSession(baseUrl: string): Promise<string> {
  const { status, body } = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { email: 'cost@example.com', password: 'hunter2-strong' },
  });
  assert.equal(status, 201);
  return body.token as string;
}

function chat(baseUrl: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return request(baseUrl, '/api/provider', {
    method: 'POST',
    body: { messages: [{ role: 'user', content: 'hi' }] },
    token,
  });
}

/**
 * Stub Groq chat with REAL usage numbers so settling has something to settle.
 * The stub honors the maxTokens cap (a real provider would too), so actual
 * spend can never exceed the reserved worst-case budget.
 */
async function withStubbedChat<T>(fn: () => Promise<T>): Promise<T> {
  process.env.GROQ_API_KEY = 'gsk_fake_key_for_tests';
  for (const key of ['NVIDIA_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'MINIMAX_API_KEY']) delete process.env[key];
  const original = GroqProvider.prototype.chat;
  GroqProvider.prototype.chat = (async (_messages: unknown, options?: { maxTokens?: number }) => {
    // Realistic usage: input ~ chars/4 of the sent messages, output capped by
    // the maxTokens the cost guard allowed (a real provider honors it too).
    const maxOut = options?.maxTokens ?? 4096;
    const outputTokens = Math.min(500, Math.max(1, maxOut));
    const inputTokens = estimateTokens(JSON.stringify(_messages));
    return {
      content: 'ok',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    };
  }) as typeof GroqProvider.prototype.chat;
  try {
    return await fn();
  } finally {
    GroqProvider.prototype.chat = original;
    delete process.env.GROQ_API_KEY;
  }
}

test('a successful request settles actual spend and records ai_usage', async () => {
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const token = await registerSession(baseUrl);
    await withStubbedChat(async () => {
      const r = await chat(baseUrl, token);
      assert.equal(r.status, 200);
    });
    // ~8 input @ $0.25/1M (2 micros) + 500 output @ $1.00/1M (500 micros).
    assert.equal(mem.aiUsage.length, 1);
    assert.equal(mem.aiUsage[0]?.estimated_cost_usd_micros, 502);
    assert.equal(mem.aiUsage[0]?.provider, 'groq');
    const ledger = mem.dailyCosts[0];
    assert.equal(ledger?.spent, 502, 'the ledger reflects the actual cost');
    assert.equal(ledger?.reserved, 0, 'the reservation was released');
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('an exhausted daily budget is refused with a friendly message and consumes no session', async () => {
  process.env.ZEESH_DAILY_COST_LIMIT_INR = '0.0001'; // ≈ 1 micro — nothing fits
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const token = await registerSession(baseUrl);
    await withStubbedChat(async () => {
      const r = await chat(baseUrl, token);
      assert.equal(r.status, 429);
      assert.equal(r.body.code, 'daily_cost_exhausted');
      const text = String(r.body.error);
      assert.match(text, /usage capacity/i);
      assert.ok(!text.includes('₹') && !text.includes('$'), 'spending is never shown to users');
      assert.ok(!text.includes('token') && !text.includes('MiniMax'), 'provider economics stay internal');
    });
    assert.equal(mem.freeSessions.length, 0, 'a cost refusal consumes no session slot');
    assert.equal(mem.aiUsage.length, 0);
    assert.equal(mem.dailyCosts.length, 0, 'a refused request writes nothing');
  } finally {
    setDbForTests(null);
    server.close();
  }
});

test('concurrent requests over HTTP cannot push a user over the ceiling', async () => {
  // Cap ≈ 6,024 micros; each admitted request settles ~502 micros — 30
  // parallel requests must be throttled at the ceiling (30 × 502 > cap),
  // and total settled spend must never exceed the cap.
  process.env.ZEESH_DAILY_COST_LIMIT_INR = '0.5'; // ≈ 6,024 micros
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const { server, baseUrl } = await startServer();
  try {
    const token = await registerSession(baseUrl);
    await withStubbedChat(async () => {
      const results = await Promise.all(Array.from({ length: 30 }, () => chat(baseUrl, token)));
      const admitted = results.filter((r) => r.status === 200).length;
      const refused = results.filter((r) => r.status === 429 && r.body.code === 'daily_cost_exhausted').length;
      assert.ok(admitted >= 1, 'the budget admits the first requests');
      assert.ok(refused >= 1, 'later requests are refused at the ceiling');
      assert.equal(admitted + refused, 30, 'every request resolves cleanly');
    });
    const cap = inrToUsdMicros(0.5, 83);
    for (const row of mem.dailyCosts) {
      assert.ok(row.spent <= cap, `spent ${row.spent} must stay ≤ ${cap}`);
      assert.equal(row.reserved, 0, 'every reservation settled or released');
    }
  } finally {
    setDbForTests(null);
    server.close();
  }
});
