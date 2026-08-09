import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { countOccurrences, replaceAll, createEditFileTool } from '../src/tools/editFile.ts';
import type { ToolContext } from '../src/tools/registry.ts';

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'zeesh-edit-'));
}

function ctx(root: string): ToolContext {
  return { projectRoot: root, askPermission: async () => false };
}

test('countOccurrences and replaceAll', () => {
  assert.equal(countOccurrences('a b a c a', 'a'), 3);
  assert.equal(countOccurrences('abc', 'z'), 0);
  assert.equal(replaceAll('a b a', 'a', 'x'), 'x b x');
});

test('edit_file applies targeted replacement and snapshots for undo', async () => {
  const root = tempProject();
  writeFileSync(join(root, 'calc.ts'), 'export const add = (a: number, b: number) => a - b;\n');
  const tool = createEditFileTool(ctx(root));
  const result = await tool.execute(
    { path: 'calc.ts', edits: [{ oldString: 'a - b', newString: 'a + b' }] },
    ctx(root),
  );
  assert.ok(result.includes('Edited calc.ts'));
  assert.equal(readFileSync(join(root, 'calc.ts'), 'utf8'), 'export const add = (a: number, b: number) => a + b;\n');
});

test('edit_file is all-or-nothing: failing edit leaves file untouched', async () => {
  const root = tempProject();
  writeFileSync(join(root, 'a.txt'), 'original content\n');
  const tool = createEditFileTool(ctx(root));
  const result = await tool.execute(
    {
      path: 'a.txt',
      edits: [
        { oldString: 'original content', newString: 'changed' },
        { oldString: 'does not exist anywhere', newString: 'x' },
      ],
    },
    ctx(root),
  );
  assert.ok(result.includes('no changes were made'));
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'original content\n');
});

test('edit_file requires allowMultiple when text appears more than once', async () => {
  const root = tempProject();
  writeFileSync(join(root, 'b.txt'), 'foo\nfoo\n');
  const tool = createEditFileTool(ctx(root));
  const single = await tool.execute({ path: 'b.txt', edits: [{ oldString: 'foo', newString: 'bar' }] }, ctx(root));
  assert.ok(single.includes('appears 2 times'));
  const multi = await tool.execute(
    { path: 'b.txt', edits: [{ oldString: 'foo', newString: 'bar', allowMultiple: true }] },
    ctx(root),
  );
  assert.equal(readFileSync(join(root, 'b.txt'), 'utf8'), 'bar\nbar\n');
});

test('edit_file refuses protected files', async () => {
  const root = tempProject();
  writeFileSync(join(root, '.env'), 'SECRET=1\n');
  const tool = createEditFileTool(ctx(root));
  const result = await tool.execute({ path: '.env', edits: [{ oldString: 'SECRET', newString: 'NOPE' }] }, ctx(root));
  assert.ok(result.includes('protected'));
});
