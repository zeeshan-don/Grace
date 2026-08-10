import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { ProjectIndexService } from '../src/project/index.ts';

const roots: string[] = [];
function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'zeesh-index-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function seedProject(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', main: 'src/index.ts', scripts: { test: 'node --test', build: 'npm run build' } }),
  );
  writeFileSync(join(root, 'src', 'index.ts'), 'export const main = () => 1;\nexport function helper() {}\n');
  writeFileSync(join(root, 'src', 'util.ts'), 'export class Util {}\n');
}

test('project index: builds a structural summary', () => {
  const root = tempProject();
  seedProject(root);
  const idx = new ProjectIndexService(root).get();
  assert.equal(idx.fileCount, 3);
  assert.ok(idx.topLevel.includes('src'));
  assert.ok(idx.entrypoints.includes('src/index.ts'));
  assert.equal(idx.testCommand, 'npm test');
  assert.ok(idx.summary.includes('node project'));
  assert.ok(idx.summary.includes('Files: 3'));
  const util = idx.importantSymbols.find((s) => s.file === 'src/util.ts');
  assert.ok(util, 'symbols scanned from source files');
  assert.ok(util!.symbols.includes('Util'));
});

test('project index: cached while the repository is unchanged', () => {
  const root = tempProject();
  seedProject(root);
  const service = new ProjectIndexService(root);
  const first = service.get();
  const second = service.get();
  assert.equal(first, second, 'same instance returned from cache');
  assert.equal(first.builtAt, second.builtAt);
});

test('project index: rebuilds when a file changes (fingerprint invalidation)', () => {
  const root = tempProject();
  seedProject(root);
  const service = new ProjectIndexService(root);
  const before = service.get();
  assert.equal(before.fileCount, 3);

  writeFileSync(join(root, 'src', 'new.ts'), 'export const fresh = 1;\n');
  const after = service.get();
  assert.equal(after.fileCount, 4, 'new file detected without an explicit invalidate()');
  assert.notEqual(after, before);
});

test('project index: invalidate() forces a rebuild', () => {
  const root = tempProject();
  seedProject(root);
  const service = new ProjectIndexService(root);
  const before = service.get();
  service.invalidate();
  const after = service.get();
  assert.notEqual(after, before, 'forced rebuild returns a fresh index');
  assert.equal(after.fileCount, 3);
});

test('project index: detects package.json changes (config fingerprint)', () => {
  const root = tempProject();
  seedProject(root);
  const service = new ProjectIndexService(root);
  const before = service.get();
  assert.equal(before.testCommand, 'npm test');

  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo', scripts: { test: 'jest' } }),
  );
  const after = service.get();
  assert.equal(after.testCommand, 'npm test', 'detectProject reports npm test when scripts.test exists');
  assert.notEqual(after, before);
  assert.ok(after.summary.includes('jest'), 'test framework detected from scripts');
});
