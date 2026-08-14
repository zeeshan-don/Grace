/**
 * Unit tests for the tool dedup cache (src/agent/toolCache.ts).
 *
 * read_file/list_directory must never serve stale results after an edit, and
 * search_files must recompute after the agent mutates the repository.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { ToolCache } from '../src/agent/toolCache.ts';

const tmpRoots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zeesh-cache-'));
  tmpRoots.push(dir);
  return dir;
}
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

test('read_file: identical unchanged file is served from cache', () => {
  const root = tempDir();
  const file = join(root, 'a.txt');
  writeFileSync(file, 'hello');
  const cache = new ToolCache();

  assert.equal(cache.getCachedRead(file), null, 'no cache before the first read');
  cache.setRead(file, 'hello');
  assert.equal(cache.getCachedRead(file), 'hello', 'unchanged file hits the cache');
});

test('read_file: an edited file is never served stale', () => {
  const root = tempDir();
  const file = join(root, 'a.txt');
  writeFileSync(file, 'v1');
  const cache = new ToolCache();
  cache.setRead(file, 'v1');

  // Force a distinct mtime so the change is observable on every platform.
  writeFileSync(file, 'v2');
  const now = Date.now() / 1000;
  utimesSync(file, now, now);

  assert.equal(cache.getCachedRead(file), null, 'edited file must be re-read');
  cache.setRead(file, 'v2');
  assert.equal(cache.getCachedRead(file), 'v2');
});

test('list_directory: identical listing is served from cache, mutations invalidate it', () => {
  const root = tempDir();
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'sub', 'x.txt'), 'x');
  const cache = new ToolCache();

  cache.setListing(join(root, 'sub'), 1, 'listing-v1');
  assert.equal(cache.getCachedListing(join(root, 'sub'), 1), 'listing-v1');

  // Any agent mutation (write/edit/run_command) invalidates listings — adding
  // an entry must never serve the stale listing.
  writeFileSync(join(root, 'sub', 'y.txt'), 'y');
  cache.invalidate();
  assert.equal(cache.getCachedListing(join(root, 'sub'), 1), null, 'mutation invalidates the listing');
});

test('list_directory: depth is part of the cache key', () => {
  const root = tempDir();
  const cache = new ToolCache();
  cache.setListing(root, 1, 'shallow');
  assert.equal(cache.getCachedListing(root, 3), null, 'different depth is a different listing');
  assert.equal(cache.getCachedListing(root, 1), 'shallow');
});

test('search_files: repeated identical search hits; mutation epoch forces recompute', () => {
  const cache = new ToolCache();
  const key = '{"query":"flask"}';

  cache.setSearch(key, 'hits-v1');
  assert.equal(cache.getCachedSearch(key), 'hits-v1');

  cache.invalidate(); // agent edited a file / ran a command
  assert.equal(cache.getCachedSearch(key), null, 'stale search must be recomputed after a mutation');
  cache.setSearch(key, 'hits-v2');
  assert.equal(cache.getCachedSearch(key), 'hits-v2');
});
