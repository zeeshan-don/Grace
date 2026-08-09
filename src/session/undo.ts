import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureDir } from '../config/config.ts';

interface Snapshot {
  file: string;
  previousContent: string | null; // null = file did not exist before
  at: string;
}

/**
 * Records the pre-modification content of files the agent changes, so the
 * user can `/undo` the most recent change. Backed by `.myagent/undo/`.
 */
export class UndoStore {
  private readonly dir: string;
  private counter = 0;

  constructor(projectRoot: string) {
    this.dir = join(projectRoot, '.myagent', 'undo');
    ensureDir(this.dir);
    this.counter = readdirSync(this.dir).filter((f) => f.endsWith('.json')).length;
  }

  /** Record a file before it is modified. Returns true when a snapshot was stored. */
  record(file: string, previousContent: string | null): boolean {
    this.counter += 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(this.dir, `${String(this.counter).padStart(6, '0')}_${stamp}.json`);
    const snap: Snapshot = { file, previousContent, at: new Date().toISOString() };
    try {
      writeFileSync(path, JSON.stringify(snap, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** Revert the most recent snapshot. Returns a description, or null if empty. */
  undo(): { file: string; hadPrevious: boolean } | null {
    const snaps = readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    if (snaps.length === 0) return null;
    const latest = snaps[snaps.length - 1] as string;
    const path = join(this.dir, latest);
    let snap: Snapshot;
    try {
      snap = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
    } catch {
      return null;
    }
    if (snap.previousContent === null) {
      // File was newly created by the agent — remove it.
      rmSync(snap.file, { force: true });
    } else {
      mkdirSync(dirname(snap.file), { recursive: true });
      writeFileSync(snap.file, snap.previousContent, 'utf8');
    }
    rmSync(path, { force: true });
    return { file: snap.file, hadPrevious: snap.previousContent !== null };
  }

  /** All pending snapshot descriptions (used by /diff when there is no git repo). */
  pendingChanges(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => {
        try {
          const snap = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Snapshot;
          return snap.previousContent === null ? `+ ${snap.file} (created)` : `~ ${snap.file} (modified)`;
        } catch {
          return '';
        }
      })
      .filter((s) => s.length > 0);
  }

  get count(): number {
    return readdirSync(this.dir).filter((f) => f.endsWith('.json')).length;
  }
}
