/**
 * Sponsorship/ad abstraction tests (src/ads/sponsor.ts).
 *
 * Sponsors are disabled by default, purely presentational, frequency-capped,
 * and can never affect model reasoning or coding. No network calls exist in
 * the module — impression/click tracking is an in-memory counter.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { SponsorService, sponsorUtcDay } from '../src/ads/sponsor.ts';

const MESSAGES = JSON.stringify([
  { id: 'cloud', text: 'Sponsored: build on our cloud platform.' },
  { id: 'tools', text: 'Sponsored: try our developer tools.' },
]);

afterEach(() => {
  delete process.env.ZEESH_SPONSOR_ENABLED;
  delete process.env.ZEESH_SPONSOR_MESSAGES;
  delete process.env.ZEESH_SPONSOR_MAX_PER_RUN;
  delete process.env.ZEESH_SPONSOR_MAX_PER_DAY;
});

test('disabled by default — no provider configured means no sponsors', () => {
  const svc = new SponsorService();
  assert.equal(svc.enabled(), false);
  assert.deepEqual(svc.selectForRun(), []);
});

test('enabled but unconfigured messages → nothing selected', () => {
  process.env.ZEESH_SPONSOR_ENABLED = 'true';
  const svc = new SponsorService();
  assert.deepEqual(svc.selectForRun(), []);
});

test('selectForRun returns configured sponsors capped per run', () => {
  process.env.ZEESH_SPONSOR_ENABLED = 'true';
  process.env.ZEESH_SPONSOR_MESSAGES = MESSAGES;
  process.env.ZEESH_SPONSOR_MAX_PER_RUN = '1';
  const svc = new SponsorService();
  const selected = svc.selectForRun(new Date('2026-08-10T12:00:00Z'));
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.id, 'cloud');
  assert.equal(svc.impressionCount('cloud'), 1, 'impressions are tracked');
});

test('frequency caps: per-run and per-day limits hold', () => {
  process.env.ZEESH_SPONSOR_ENABLED = 'true';
  process.env.ZEESH_SPONSOR_MESSAGES = MESSAGES;
  process.env.ZEESH_SPONSOR_MAX_PER_RUN = '1';
  process.env.ZEESH_SPONSOR_MAX_PER_DAY = '2';
  const svc = new SponsorService();
  const day = new Date('2026-08-10T12:00:00Z');
  assert.equal(svc.selectForRun(day).length, 1);
  assert.equal(svc.selectForRun(day).length, 1, 'second run still allowed (2/day cap)');
  assert.equal(svc.selectForRun(day).length, 0, 'daily cap reached → no more sponsors');
  // A new UTC day resets the cap.
  assert.equal(svc.selectForRun(new Date('2026-08-11T12:00:00Z')).length, 1);
});

test('sponsorUtcDay buckets by UTC date (deterministic daily reset)', () => {
  assert.equal(sponsorUtcDay(new Date('2026-08-10T23:59:59.999Z')), '2026-08-10');
  assert.equal(sponsorUtcDay(new Date('2026-08-11T00:00:00.000Z')), '2026-08-11');
});

test('invalid sponsor config degrades to no sponsors (never blocks coding)', () => {
  process.env.ZEESH_SPONSOR_ENABLED = 'true';
  process.env.ZEESH_SPONSOR_MESSAGES = 'not json';
  const svc = new SponsorService();
  assert.deepEqual(svc.selectForRun(), []);
  // recordClick is a safe no-op for unknown ids.
  svc.recordClick('cloud');
  assert.equal(svc.impressionCount('cloud'), 0);
});
