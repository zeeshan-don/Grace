/**
 * Per-run tool-result cache (agent loop).
 *
 * Stops the loop from re-reading the same file / re-listing the same directory
 * / re-running the same search when nothing changed — the "tool loop
 * thrashing" problem. Correctness rules:
 *
 *   - read_file is keyed by path and re-validated against the file's mtime +
 *     size, so an agent edit (or an external edit) instantly invalidates it.
 *   - list_directory is keyed by path + depth and re-validated against the
 *     directory's mtime (listings only show entry names/sizes, so file-content
 *     edits cannot stale a listing).
 *   - search_files is keyed by the full normalized query + an "epoch" that is
 *     bumped whenever the agent mutates the repository (write/edit/run_command),
 *     so a search never serves stale hits after an edit.
 *
 * Only successful (non-"Error:") results are cached, so transient failures are
 * never masked. The cache lives for one agent run.
 */
import { statSync, type Stats } from 'node:fs';

interface ReadEntry {
  mtimeMs: number;
  size: number;
  result: string;
}

interface ListEntry {
  mtimeMs: number;
  /** Epoch at which the listing was taken — a mutation invalidates it. */
  epoch: number;
  result: string;
}

export class ToolCache {
  private reads = new Map<string, ReadEntry>();
  private listings = new Map<string, ListEntry>();
  private searches = new Map<string, string>();
  private epoch = 0;

  /** The current repository-mutation epoch (bumped by invalidate). */
  get epochValue(): number {
    return this.epoch;
  }

  /**
   * Call after any tool that can change repository state (write_file,
   * edit_file, run_command). Invalidates search hits so they are recomputed.
   * read/list caches self-invalidate via mtime.
   */
  invalidate(): void {
    this.epoch += 1;
    this.searches.clear();
    this.listings.clear();
  }

  // -------------------------------------------------------------------------
  // read_file
  // -------------------------------------------------------------------------

  getCachedRead(absPath: string): string | null {
    const st = statSyncSafe(absPath);
    if (!st || !st.isFile()) return null;
    const entry = this.reads.get(absPath);
    if (entry && entry.mtimeMs === stampMs(st) && entry.size === Number(st.size)) return entry.result;
    return null;
  }

  setRead(absPath: string, result: string): void {
    const st = statSyncSafe(absPath);
    if (!st || !st.isFile()) return;
    this.reads.set(absPath, { mtimeMs: stampMs(st), size: Number(st.size), result });
  }

  // -------------------------------------------------------------------------
  // list_directory
  // -------------------------------------------------------------------------

  getCachedListing(absPath: string, depth: number): string | null {
    const st = statSyncSafe(absPath);
    if (!st || !st.isDirectory()) return null;
    const entry = this.listings.get(key(absPath, depth));
    // Epoch guard (authoritative for agent mutations) + mtime guard (catches
    // external entry changes where the FS reports them).
    if (entry && entry.epoch === this.epoch && entry.mtimeMs === stampMs(st)) return entry.result;
    return null;
  }

  setListing(absPath: string, depth: number, result: string): void {
    const st = statSyncSafe(absPath);
    if (!st || !st.isDirectory()) return;
    this.listings.set(key(absPath, depth), { mtimeMs: stampMs(st), epoch: this.epoch, result });
  }

  // -------------------------------------------------------------------------
  // search_files
  // -------------------------------------------------------------------------

  getCachedSearch(queryKey: string): string | null {
    return this.searches.get(`${this.epoch}::${queryKey}`) ?? null;
  }

  setSearch(queryKey: string, result: string): void {
    this.searches.set(`${this.epoch}::${queryKey}`, result);
  }
}

function key(absPath: string, depth: number): string {
  return `${absPath}@${depth}`;
}

/** mtimeMs can be typed `number | bigint` — normalize to number. */
function stampMs(st: Stats): number {
  return Number(st.mtimeMs);
}

function statSyncSafe(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}
