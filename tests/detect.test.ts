import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { detectProject } from '../src/project/detect.ts';

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'zeesh-detect-'));
}

test('detects a Node/Next project with pnpm', () => {
  const root = tempProject();
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'x', dependencies: { next: '15.0.0', react: '19.0.0' }, scripts: { test: 'jest' } }),
  );
  writeFileSync(join(root, 'pnpm-lock.yaml'), '');
  writeFileSync(join(root, 'tsconfig.json'), '{}');
  const info = detectProject(root);
  assert.equal(info.type, 'node');
  assert.equal(info.framework, 'next');
  assert.equal(info.packageManager, 'pnpm');
  assert.ok(info.languages.includes('typescript'));
  assert.equal(info.testCommand, 'npm test');
});

test('detects a Python project', () => {
  const root = tempProject();
  writeFileSync(join(root, 'pyproject.toml'), '[project]\nname="x"\n');
  writeFileSync(join(root, 'uv.lock'), '');
  const info = detectProject(root);
  assert.equal(info.type, 'python');
  assert.equal(info.packageManager, 'uv');
  assert.equal(info.testCommand, 'python -m pytest');
});

test('detects an empty project as unknown', () => {
  const root = tempProject();
  const info = detectProject(root);
  assert.equal(info.type, 'unknown');
  assert.equal(info.packageManager, 'none');
});
