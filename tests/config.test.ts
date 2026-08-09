import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Point the home directory at a throwaway location BEFORE config.ts loads so
// these tests never read or write the real user's config.
const home = mkdtempSync(join(tmpdir(), 'zeesh-config-home-'));

process.env.HOME = home;
process.env.USERPROFILE = home;

after(() => {
  rmSync(home, { recursive: true, force: true });
});

test('config lives under ~/.zeesh and migrates a legacy ~/.myagent once', async () => {
  // Seed a legacy ~/.myagent directory exactly like the pre-rename CLI did.
  const legacy = join(home, '.myagent');
  mkdirSync(join(legacy, 'undo'), { recursive: true });
  writeFileSync(join(legacy, 'env'), 'GROQ_API_KEY=sk-legacy-test\n');
  writeFileSync(join(legacy, 'config.json'), '{"model":"openai/gpt-oss-120b"}\n');
  writeFileSync(join(legacy, 'auth.json'), '{"token":"legacy-token"}\n');

  // Import AFTER seeding so the module-level one-time migration runs on it.
  const config = await import('../src/config/config.ts');

  // New paths point at ~/.zeesh.
  assert.ok(config.CONFIG_PATH.startsWith(join(home, '.zeesh')));

  // The migration copied everything into ~/.zeesh …
  assert.equal(readFileSync(join(home, '.zeesh', 'env'), 'utf8'), 'GROQ_API_KEY=sk-legacy-test\n');
  assert.equal(readFileSync(join(home, '.zeesh', 'config.json'), 'utf8'), '{"model":"openai/gpt-oss-120b"}\n');
  assert.equal(readFileSync(join(home, '.zeesh', 'auth.json'), 'utf8'), '{"token":"legacy-token"}\n');
  assert.ok(existsSync(join(home, '.zeesh', 'undo')));

  // … and the legacy directory is preserved (copied, never deleted).
  assert.ok(existsSync(legacy), 'legacy ~/.myagent must not be deleted by the migration');
});

test('migration never overwrites an existing ~/.zeesh', async () => {
  const legacy = join(home, '.myagent');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'env'), 'GROQ_API_KEY=sk-legacy-2\n');
  mkdirSync(join(home, '.zeesh'), { recursive: true });
  writeFileSync(join(home, '.zeesh', 'env'), 'GROQ_API_KEY=sk-new\n');

  const config = await import('../src/config/config.ts');
  config.migrateLegacyConfig();

  // The existing ~/.zeesh content wins.
  assert.equal(readFileSync(join(home, '.zeesh', 'env'), 'utf8'), 'GROQ_API_KEY=sk-new\n');
});
