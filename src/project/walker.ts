import { openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isIgnored, type IgnoreRule, loadGitignoreRules } from './gitignore.ts';

export interface WalkOptions {
  /** Max files returned (default 5000). */
  maxFiles?: number;
  /** Max directory depth (default 12). */
  maxDepth?: number;
}

export interface WalkedFile {
  /** Path relative to root, forward slashes. */
  rel: string;
  /** Absolute path. */
  abs: string;
  size: number;
}

/**
 * Recursively list files under `root`, respecting .gitignore files
 * (including nested ones) and common ignored directories.
 */
export function walkFiles(root: string, opts: WalkOptions = {}): WalkedFile[] {
  const maxFiles = opts.maxFiles ?? 5000;
  const maxDepth = opts.maxDepth ?? 12;
  const out: WalkedFile[] = [];

  interface Frame {
    absDir: string;
    relDir: string;
    depth: number;
    rules: IgnoreRule[];
  }

  const stack: Frame[] = [{ absDir: root, relDir: '', depth: 0, rules: loadGitignoreRules(root, '') }];

  while (stack.length > 0 && out.length < maxFiles) {
    const frame = stack.pop() as Frame;
    let entries: string[];
    try {
      entries = readdirSync(frame.absDir);
    } catch {
      continue;
    }
    entries.sort();

    for (const name of entries) {
      const abs = join(frame.absDir, name);
      const relDir = frame.relDir ? `${frame.relDir}/${name}` : name;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        if (isIgnored(relDir, true, frame.rules)) continue;
        if (frame.depth >= maxDepth) continue;
        const nested = loadGitignoreRules(abs, relDir);
        stack.push({ absDir: abs, relDir, depth: frame.depth + 1, rules: frame.rules.concat(nested) });
      } else if (st.isFile()) {
        if (isIgnored(relDir, false, frame.rules)) continue;
        out.push({ rel: relDir, abs, size: st.size });
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

export function relFrom(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

/** Read up to `maxBytes` of a file, marking when it was truncated. */
export function readFileSafe(abs: string, maxBytes = 1_000_000): { content: string; truncated: boolean } {
  const st = statSync(abs);
  if (st.size > maxBytes) {
    const fd = openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      let offset = 0;
      while (offset < buf.length) {
        const n = readSync(fd, buf, offset, buf.length - offset, offset);
        if (n <= 0) break;
        offset += n;
      }
      return { content: buf.toString('utf8') + '\n… [file truncated, too large]', truncated: true };
    } finally {
      closeSync(fd);
    }
  }
  return { content: readFileSync(abs, 'utf8'), truncated: false };
}
