import assert from 'node:assert/strict';
import test from 'node:test';
import { isIgnored, parseGitignore } from '../src/project/gitignore.ts';

const rules = parseGitignore(
  [
    'node_modules/',
    'dist/',
    '*.log',
    '!important.log',
    '/root-only.txt',
    'src/generated/',
    '*.min.js',
  ].join('\n'),
  '',
);

test('ignores gitignored paths', () => {
  assert.equal(isIgnored('node_modules/pkg/index.js', false, rules), true);
  assert.equal(isIgnored('dist/bundle.js', false, rules), true);
  assert.equal(isIgnored('debug.log', false, rules), true);
  assert.equal(isIgnored('src/generated/schema.ts', false, rules), true);
  assert.equal(isIgnored('vendor/app.min.js', false, rules), true);
});

test('negation re-includes', () => {
  assert.equal(isIgnored('important.log', false, rules), false);
});

test('anchored patterns only match at root', () => {
  assert.equal(isIgnored('root-only.txt', false, rules), true);
  assert.equal(isIgnored('sub/root-only.txt', false, rules), false);
});

test('always ignores .git, .zeesh and legacy .myagent', () => {
  assert.equal(isIgnored('.git/config', false, []), true);
  assert.equal(isIgnored('.zeesh/session.json', false, []), true);
  assert.equal(isIgnored('.myagent/session.json', false, []), true); // pre-rename state dir
});

test('dir-only rule does not ignore same-named file', () => {
  assert.equal(isIgnored('dist', true, rules), true);
  assert.equal(isIgnored('dist', false, rules), false);
});

test('nested gitignore rules are anchored to their directory', () => {
  const nested = parseGitignore('build/', 'packages/foo');
  assert.equal(isIgnored('packages/foo/build/x.js', false, nested), true);
  assert.equal(isIgnored('packages/bar/build/x.js', false, nested), false);
});
