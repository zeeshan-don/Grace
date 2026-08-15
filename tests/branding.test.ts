/**
 * GRACE branding + default-model tests.
 *
 * The CLI is user-facing GRACE (inspired by Grace Hopper) — never ZEESH AI.
 * And because NVIDIA is the primary provider, the default model must be a
 * NVIDIA-served model, not a Groq-only one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBanner } from '../src/cli/banner.ts';
import { DEFAULT_MODELS } from '../src/config/config.ts';
import { DEFAULT_NVIDIA_MODEL } from '../src/providers/nvidia.ts';
import { DISPLAY_NAME, PRODUCT, TAGLINE, VERSION } from '../src/meta.ts';

test('meta: GRACE identity (product, display name, tagline)', () => {
  assert.equal(PRODUCT, 'grace');
  assert.equal(DISPLAY_NAME, 'GRACE');
  assert.equal(TAGLINE, 'AI Coding Agent');
  assert.equal(VERSION, '0.1.0');
  assert.ok(!/zeesh/i.test(`${DISPLAY_NAME} ${TAGLINE}`), 'no ZEESH branding in the product identity');
});

test('banner: renders GRACE with provider/model and no ZEESH branding', () => {
  const out = renderBanner({
    directory: 'D:\\work\\app',
    provider: 'NVIDIA NIM',
    model: 'openai/gpt-oss-20b',
    session: 'logged in as dev@example.com',
    freePlan: 'Quota · 5 sessions remaining',
  });
  assert.match(out, /GRACE/);
  assert.match(out, /AI Coding Agent · v0\.1\.0/);
  assert.match(out, /NVIDIA NIM/);
  assert.match(out, /gpt-oss-20b/);
  assert.match(out, /Quota/);
  assert.match(out, /Type \/help for commands\./);
  assert.ok(!/ZEESH/i.test(out), 'no ZEESH branding in the banner');
});

test('default model is NVIDIA-first, not a Groq-only model', () => {
  assert.equal(DEFAULT_MODELS[0], DEFAULT_NVIDIA_MODEL, 'the default model is NVIDIA-served gpt-oss-20b');
  assert.ok(
    !DEFAULT_MODELS[0]!.startsWith('llama-'),
    'the default is not a Groq-only id',
  );
});
