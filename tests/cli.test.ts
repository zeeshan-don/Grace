import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Isolated HOME so the CLI never touches the real user's config while testing.
const home = mkdtempSync(join(tmpdir(), 'zeesh-cli-home-'));

after(() => {
  rmSync(home, { recursive: true, force: true });
});

const ENV = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  NO_COLOR: '1',
};

const ENTRY = join(process.cwd(), 'src', 'index.ts');

function runCli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'node',
      [ENTRY, ...args],
      { env: ENV, timeout: 15_000 },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

test('zeesh --version prints the CLI name and version', async () => {
  const { code, stdout, stderr } = await runCli('--version');
  assert.equal(code, 0, stdout + stderr);
  assert.match(stdout.trim(), /^zeesh v0\.1\.0$/);
});

test('zeesh --help uses the zeesh command name and ZEESH_* env vars', async () => {
  const { code, stdout } = await runCli('--help');
  assert.equal(code, 0);
  assert.match(stdout, /zeesh login \[email\]/);
  assert.match(stdout, /zeesh register \[email\]/);
  assert.match(stdout, /zeesh logout/);
  assert.match(stdout, /zeesh whoami/);
  assert.match(stdout, /ZEESH_SHELL/);
  assert.ok(!stdout.includes('MYAGENT_SHELL'), 'no legacy MYAGENT_SHELL in help');
  assert.ok(!stdout.includes('myagent'), 'no legacy myagent branding in help');
});
