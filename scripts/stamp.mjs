#!/usr/bin/env node
/**
 * Build stamp (GRACE).
 *
 * Writes dist/build.json after `tsc` so `grace --version` can prove WHICH
 * build is actually running (timestamp + git commit). dist/ is git-ignored,
 * so this stamp is the only reliable way to confirm the installed `grace`
 * command is executing the freshly built code.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
mkdirSync(distDir, { recursive: true });

let commit = '';
try {
  commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  // Not a git checkout — the timestamp alone is still a valid proof of build.
}

const stamp = {
  builtAt: new Date().toISOString(),
  commit: commit || null,
  node: process.version,
};
writeFileSync(join(distDir, 'build.json'), `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');

const time = new Date(stamp.builtAt).toLocaleString();
console.log(`[build] dist/build.json written (${time}${commit ? ` · commit ${commit}` : ''})`);
