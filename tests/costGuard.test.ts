/**
 * Cost guard tests (src/api/costGuard.ts) against the in-memory db.
 *
 * Covers the ₹20 daily ceiling (#20), reservation-based overspend protection
 * (#21), failed-request release (#22), concurrent race safety (#23) and the
 * global circuit breaker (#24). The CLI/client is never trusted — everything
 * is enforced server-side through the atomic ledger.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { CostGuardService, DEFAULT_DAILY_COST_LIMIT_INR } from '../src/api/costGuard.ts';
import { inrToUsdMicros } from '../src/costs/money.ts';
import { createMemoryDb } from './helpers/memoryDb.ts';
import type { ChatRequest } from '../src/api/providers.ts';

const FIXED_NOW = new Date('2026-08-10T12:00:00.000Z');
const DAY = '2026-08-10';
const MONTH = '2026-08';

afterEach(() => {
  delete process.env.GROQ_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.MINIMAX_API_KEY;
  delete process.env.ZEESH_DAILY_COST_LIMIT_INR;
  delete process.env.ZEESH_INR_PER_USD;
  delete process.env.ZEESH_GLOBAL_DAILY_COST_LIMIT_INR;
  delete process.env.ZEESH_GLOBAL_MONTHLY_COST_LIMIT_INR;
  delete process.env.ZEESH_SERVER_ROUTING;
});

function setup(env: Record<string, string> = {}): { mem: ReturnType<typeof createMemoryDb>; svc: CostGuardService } {
  // This environment exports real .env keys — clear every provider key so the
  // chain under test is exactly the one the test intends (groq only).
  for (const key of ['NVIDIA_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'MINIMAX_API_KEY']) delete process.env[key];
  process.env.GROQ_API_KEY = 'gsk_fake_key_for_tests';
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const mem = createMemoryDb();
  const svc = new CostGuardService(mem.db, { now: () => FIXED_NOW });
  return { mem, svc };
}

function chatReq(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return { messages: [{ role: 'user', content: 'hi' }], ...overrides };
}

const actualUsage = {
  provider: 'groq',
  model: 'openai/gpt-oss-120b',
  inputTokens: 10,
  cachedInputTokens: 0,
  outputTokens: 10,
};

// ---------------------------------------------------------------------------
// Basic reservation + settle lifecycle
// ---------------------------------------------------------------------------

test('guardChat reserves worst-case budget and bounds max output tokens', async () => {
  const { mem, svc } = setup();
  const gate = await svc.guardChat('u-1', chatReq(), null);
  assert.equal(gate.ok, true);
  if (gate.ok) {
    assert.ok(gate.reservation, 'a reservation is created');
    // Conservative input bound (56 serialized chars @ $0.25/1M = 14 micros)
    // + 4096 output @ $1.00/1M.
    assert.equal(gate.reservation?.reservedMicros, 14 + 4096, 'conservative input + 4096 output at worst price');
    assert.equal(gate.maxTokens, 4096, 'default cap fits within the daily budget');
    assert.equal(gate.reservation?.day, DAY);
    assert.equal(gate.reservation?.month, MONTH);
    assert.equal(gate.reservation?.userId, 'u-1');
  }
  const ledger = mem.dailyCosts.find((r) => r.user_id === 'u-1' && r.day === DAY);
  assert.equal(ledger?.reserved, 4110, 'the reservation is recorded in the ledger');
  assert.equal(ledger?.spent, 0);

  // Settle with the actual usage → spent reflects reality, reserved released.
  await svc.settle(gate.ok ? gate.reservation : null, actualUsage);
  const after = mem.dailyCosts.find((r) => r.user_id === 'u-1' && r.day === DAY);
  assert.equal(after?.reserved, 0, 'unused reservation released');
  assert.equal(after?.spent, 13, 'actual cost settled (10 in @$0.25 + 10 out @$1.00)');
  assert.equal(mem.aiUsage.length, 1, 'one ai_usage row recorded');
  assert.equal(mem.aiUsage[0]?.estimated_cost_usd_micros, 13);
  assert.equal(mem.aiUsage[0]?.day, DAY);
});

test('a failed request releases the reservation in full (nothing spent)', async () => {
  const { mem, svc } = setup();
  const gate = await svc.guardChat('u-1', chatReq(), null);
  assert.equal(gate.ok, true);
  await svc.settle(gate.ok ? gate.reservation : null, null);
  const ledger = mem.dailyCosts.find((r) => r.user_id === 'u-1' && r.day === DAY);
  assert.equal(ledger?.reserved, 0, 'reservation fully released');
  assert.equal(ledger?.spent, 0, 'nothing was spent');
  assert.equal(mem.aiUsage.length, 0, 'no usage row for a failed request');
});

// ---------------------------------------------------------------------------
// ₹20 daily ceiling (#20) + overspend protection (#21)
// ---------------------------------------------------------------------------

test('the default daily ceiling is ₹20 ≈ $0.240964 (240,964 microdollars)', () => {
  assert.equal(DEFAULT_DAILY_COST_LIMIT_INR, 20);
  assert.equal(inrToUsdMicros(20, 83), 240_964);
});

test('guardChat refuses once the daily budget is exhausted (#20)', async () => {
  const { mem, svc } = setup({ ZEESH_DAILY_COST_LIMIT_INR: '0.001' }); // ≈12 micros
  const gate = await svc.guardChat('u-1', chatReq(), null);
  assert.equal(gate.ok, false);
  if (!gate.ok) {
    assert.equal(gate.code, 'daily_cost_exhausted');
    assert.equal(gate.status, 429);
    assert.match(gate.error, /usage capacity/i);
    assert.ok(!gate.error.includes('₹'), 'user-facing text never reveals spending');
    assert.ok(!gate.error.includes('$'));
    assert.ok(!gate.error.includes('token'));
    assert.ok(gate.retryAfterSeconds !== undefined && gate.retryAfterSeconds >= 1);
  }
  assert.equal(mem.dailyCosts.length, 0, 'a refused request writes nothing');
});

test('guardChat caps max output tokens to the remaining budget (#21)', async () => {
  // Cap ≈ 1,000 micros → budget allows ~997 output tokens (below the 4096 default).
  const { svc } = setup({ ZEESH_DAILY_COST_LIMIT_INR: '0.0826' });
  const gate = await svc.guardChat('u-1', chatReq(), null);
  assert.equal(gate.ok, true);
  if (gate.ok) {
    assert.ok((gate.maxTokens ?? 0) < 4096, 'max output is limited by the budget');
    assert.ok((gate.maxTokens ?? 0) >= 64, 'still above the minimum useful output');
  }
});

test('guardChat never starts a request that could obviously exceed the budget', async () => {
  // Cap so small that even the minimum output allowance cannot be afforded.
  const { mem, svc } = setup({ ZEESH_DAILY_COST_LIMIT_INR: '0.005' });
  const gate = await svc.guardChat('u-1', chatReq(), null);
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.equal(gate.code, 'daily_cost_exhausted');
  assert.equal(mem.freeSessions.length, 0);
  assert.equal(mem.dailyCosts.length, 0);
});

test('a client-supplied maxTokens below the budget cap is preserved', async () => {
  const { svc } = setup();
  const gate = await svc.guardChat('u-1', chatReq({ maxTokens: 512 }), null);
  assert.equal(gate.ok, true);
  if (gate.ok) assert.equal(gate.maxTokens, 512);
});

// ---------------------------------------------------------------------------
// Concurrency (#23) — multiple processes can never push a user over the cap
// ---------------------------------------------------------------------------

test('concurrent reservations never exceed the daily ceiling (#23)', async () => {
  const { mem, svc } = setup({ ZEESH_DAILY_COST_LIMIT_INR: '8' }); // ≈ 96,386 micros
  // ~4,100 micros reserved per request → only ~23 fit; 50 concurrent requests
  // from ONE user (multiple processes) must be throttled by the atomic ledger.
  const gates = await Promise.all(Array.from({ length: 50 }, () => svc.guardChat('u-1', chatReq(), null)));

  // Every admitted request settles to actual spend; every refusal is clean.
  let admitted = 0;
  let refused = 0;
  for (const gate of gates) {
    if (gate.ok) {
      admitted += 1;
      await svc.settle(gate.reservation, actualUsage);
    } else {
      refused += 1;
      assert.equal(gate.code, 'daily_cost_exhausted');
    }
  }
  assert.ok(refused > 0, 'some concurrent requests must be refused under a tight cap');
  assert.ok(admitted > 0, 'the budget is not exhausted by an empty estimate');

  // The invariant holds: spent never exceeds the ceiling, everything settled.
  const cap = inrToUsdMicros(8, 83);
  assert.equal(mem.dailyCosts.length, 1, 'one ledger row for the user');
  const row = mem.dailyCosts[0];
  assert.ok(row !== undefined && row.spent <= cap, `spent ${row?.spent} ≤ ${cap}`);
  assert.equal(row?.reserved, 0, 'all reservations settled/released');
  assert.ok(mem.aiUsage.length === admitted, 'one usage row per admitted request');
});

// ---------------------------------------------------------------------------
// Global circuit breaker (#24)
// ---------------------------------------------------------------------------

test('the global daily circuit breaker refuses requests past the global cap (#24)', async () => {
  const { mem, svc } = setup({ ZEESH_GLOBAL_DAILY_COST_LIMIT_INR: '0.1' }); // ≈ 1,205 micros < 4,100 reserve
  const gate = await svc.guardChat('u-1', chatReq(), null);
  assert.equal(gate.ok, false);
  if (!gate.ok) {
    assert.equal(gate.code, 'global_cost_exhausted');
    assert.equal(gate.status, 429);
    assert.match(gate.error, /temporarily at capacity/i);
  }
  // The daily reservation is created first, then released on the refusal.
  const ledger = mem.dailyCosts[0];
  assert.equal(ledger?.reserved ?? 0, 0, 'the daily reservation is released');
  assert.equal(ledger?.spent ?? 0, 0, 'nothing was spent');
});

test('the global monthly circuit breaker refuses requests past the monthly cap', async () => {
  const { mem, svc } = setup({ ZEESH_GLOBAL_MONTHLY_COST_LIMIT_INR: '0.1' });
  const gate = await svc.guardChat('u-1', chatReq(), null);
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.equal(gate.code, 'global_cost_exhausted');
  const ledger = mem.dailyCosts[0];
  assert.equal(ledger?.reserved ?? 0, 0, 'the daily reservation is released');
});

test('the global ledger settles actual spend and releases reservations', async () => {
  // Both global caps on → both periods get a ledger row.
  const { mem, svc } = setup({ ZEESH_GLOBAL_DAILY_COST_LIMIT_INR: '100', ZEESH_GLOBAL_MONTHLY_COST_LIMIT_INR: '100' });
  const gate = await svc.guardChat('u-1', chatReq(), null);
  assert.equal(gate.ok, true);
  await svc.settle(gate.ok ? gate.reservation : null, actualUsage);

  const daily = mem.globalCosts.find((r) => r.period_type === 'day' && r.period === DAY);
  const monthly = mem.globalCosts.find((r) => r.period_type === 'month' && r.period === MONTH);
  assert.equal(daily?.spent, 13);
  assert.equal(daily?.reserved, 0);
  assert.equal(monthly?.spent, 13);
  assert.equal(monthly?.reserved, 0);
});

test('global cost is shared across users (cross-user circuit breaker)', async () => {
  const { mem, svc } = setup({ ZEESH_GLOBAL_DAILY_COST_LIMIT_INR: '0.5' }); // ≈ 6,024 micros — fits ~1 request
  const g1 = await svc.guardChat('u-1', chatReq(), null);
  const g2 = await svc.guardChat('u-2', chatReq(), null);
  // u-2's reserve (~4,100) + u-1's reserve (~4,100) = ~8,200 > 6,024 → one refused.
  const outcomes = [g1, g2].filter((g) => g.ok);
  const refusals = [g1, g2].filter((g) => !g.ok);
  assert.equal(outcomes.length, 1, 'the global cap admits only one');
  assert.equal(refusals.length, 1);
  if (refusals[0] && !refusals[0].ok) assert.equal(refusals[0].code, 'global_cost_exhausted');
  // The admitted user keeps a reserved row; the refused user's reservation
  // was released (its daily row exists but is fully released).
  const admitted = mem.dailyCosts.find((r) => r.user_id === 'u-1');
  assert.equal(admitted?.reserved, 4110);
  const refusedLedger = mem.dailyCosts.find((r) => r.user_id === 'u-2');
  assert.equal(refusedLedger?.reserved ?? 0, 0, 'the refused reservation is released');
  assert.equal(refusedLedger?.spent ?? 0, 0);
});

// ---------------------------------------------------------------------------
// No providers configured
// ---------------------------------------------------------------------------

test('guardChat refuses with 503 when no server-side provider key is configured', async () => {
  delete process.env.GROQ_API_KEY;
  const mem = createMemoryDb();
  const svc = new CostGuardService(mem.db, { now: () => FIXED_NOW });
  const gate = await svc.guardChat('u-1', chatReq(), null);
  assert.equal(gate.ok, false);
  if (!gate.ok) {
    assert.equal(gate.code, 'no_providers');
    assert.equal(gate.status, 503);
    assert.match(gate.error, /GROQ_API_KEY/);
  }
});
