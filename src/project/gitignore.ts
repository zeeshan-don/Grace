import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal .gitignore matcher.
 *
 * Supports the common subset of gitignore syntax:
 *  - blank lines and `#` comments
 *  - `!` negation
 *  - trailing `/` (directory-only)
 *  - leading `/` (anchored to the .gitignore location)
 *  - patterns containing `/` are anchored to the .gitignore location
 *  - patterns without `/` match the basename at any depth
 *  - `*`, `?`, `**`, `[...]` globs
 */
export interface IgnoreRule {
  /** Compiled matcher. */
  regex: RegExp;
  /** True when this rule re-includes files (`!pattern`). */
  negated: boolean;
  /** True when this rule only matches directories. */
  dirOnly: boolean;
  /** True when the pattern is anchored to its .gitignore location. */
  anchored: boolean;
  /** Relative dir (from project root, '' for root) containing the .gitignore. */
  baseRel: string;
}

const ALWAYS_IGNORED = new Set(['.git', 'node_modules', '.zeesh', '.myagent']); // .myagent = pre-rename state dir

function globToRegExp(pattern: string): RegExp {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**` — matches anything including slashes
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      out += '[^/]';
      i += 1;
    } else if (ch === '[') {
      // character class — copy until closing bracket
      let j = i + 1;
      let cls = '';
      if (pattern[j] === '!' || pattern[j] === '^') {
        cls += '^';
        j += 1;
      }
      while (j < pattern.length && pattern[j] !== ']') {
        if (pattern[j] === '\\') {
          cls += '\\\\' + (pattern[j + 1] ?? '');
          j += 2;
        } else {
          cls += pattern[j];
          j += 1;
        }
      }
      if (j >= pattern.length) {
        out += '\\[';
        i += 1;
      } else {
        out += '[' + cls + ']';
        i = j + 1;
      }
    } else {
      out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp('^' + out + '$');
}

/** Parse the contents of a .gitignore located at `baseRel` ('' for project root). */
export function parseGitignore(content: string, baseRel: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('\\#')) line = line.slice(1);

    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }
    if (!line) continue;

    // Trailing spaces are stripped unless escaped
    line = line.replace(/\s+$/, '');

    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) continue;

    let anchored = false;
    if (line.startsWith('/')) {
      anchored = true;
      line = line.slice(1);
    } else if (line.includes('/')) {
      anchored = true;
    }

    try {
      rules.push({ regex: globToRegExp(line), negated, dirOnly, anchored, baseRel });
    } catch {
      // Skip malformed patterns rather than crashing the walker
    }
  }
  return rules;
}

/** Load .gitignore rules from a directory (returns [] when absent). */
export function loadGitignoreRules(dir: string, baseRel: string): IgnoreRule[] {
  try {
    return parseGitignore(readFileSync(join(dir, '.gitignore'), 'utf8'), baseRel);
  } catch {
    return [];
  }
}

/** Normalize a relative path to forward slashes without a leading slash. */
export function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^\/+/, '');
}

/**
 * Decide whether `rel` (relative path from project root, forward slashes)
 * is ignored by the given rules. Returns true when ignored.
 *
 * Directory-only rules also match files under the matched directory, so a
 * rule like `dist/` ignores `dist/bundle.js` as well as `dist/` itself.
 */
export function isIgnored(rel: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  const normalized = normalizeRel(rel);
  const segments = normalized.split('/');

  if (segments.some((s) => ALWAYS_IGNORED.has(s))) return true;

  // Ancestor directory prefixes (for directory-only rules). Includes the
  // path itself when it is a directory.
  const dirPrefixes: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    dirPrefixes.push(segments.slice(0, i).join('/'));
  }
  if (isDir) dirPrefixes.push(normalized);

  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly) {
      // Matches when any ancestor directory (or the dir itself) matches.
      for (const dir of dirPrefixes) {
        const relToBase = applyBase(rule, dir);
        if (relToBase === '') continue;
        const target = rule.anchored ? relToBase : lastSegment(relToBase);
        if (rule.regex.test(target)) {
          ignored = !rule.negated;
          break;
        }
      }
    } else {
      const relToBase = applyBase(rule, normalized);
      if (relToBase === '') continue;
      const target = rule.anchored ? relToBase : lastSegment(relToBase);
      if (rule.regex.test(target)) ignored = !rule.negated;
    }
  }
  return ignored;
}

/** Reduce `path` relative to a rule's .gitignore location ('' when out of scope). */
function applyBase(rule: IgnoreRule, path: string): string {
  if (rule.baseRel === '') return path;
  const prefix = normalizeRel(rule.baseRel) + '/';
  return path.startsWith(prefix) ? path.slice(prefix.length) : '';
}

function lastSegment(path: string): string {
  const segs = path.split('/');
  return segs[segs.length - 1] as string;
}
