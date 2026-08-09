import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isProtectedPath, redactSecrets } from '../safety/policy.ts';
import { walkFiles } from '../project/walker.ts';
import { truncateText } from '../util/text.ts';
import type { Tool, ToolContext } from './registry.ts';

const MAX_RESULTS = 100;
const MAX_OUTPUT = 30_000;

export function createSearchFilesTool(ctx: ToolContext): Tool {
  return {
    name: 'search_files',
    description: 'Search repo for text/symbols/filenames (honors .gitignore).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for.' },
        mode: { type: 'string', enum: ['content', 'filename'], description: 'Default content.' },
        caseInsensitive: { type: 'boolean', description: 'Default true.' },
        word: { type: 'boolean', description: 'Whole word only.' },
        globs: { type: 'array', items: { type: 'string' }, description: 'File glob filters.' },
        maxResults: { type: 'number', description: 'Cap on matches.' },
      },
      required: ['query'],
    },
    async execute(args) {
      const query = typeof args.query === 'string' ? args.query : '';
      const mode = args.mode === 'filename' ? 'filename' : 'content';
      const caseInsensitive = args.caseInsensitive !== false;
      const word = args.word === true;
      const globs = Array.isArray(args.globs) ? (args.globs as string[]).filter((g) => typeof g === 'string') : [];
      const maxResults =
        typeof args.maxResults === 'number' && args.maxResults > 0 ? Math.min(Math.floor(args.maxResults), MAX_RESULTS) : MAX_RESULTS;

      if (!query) return 'Error: "query" is required.';

      if (mode === 'filename') {
        return searchFilenames(query, caseInsensitive, maxResults, globs, ctx.projectRoot);
      }

      // Try ripgrep first (fast, respects .gitignore); fall back to the built-in walker.
      const rg = tryRipgrep(ctx, query, caseInsensitive, word, globs, maxResults);
      if (rg.found) return truncateText(redactSecrets(rg.output), MAX_OUTPUT);

      const results = searchFallback(ctx.projectRoot, query, caseInsensitive, word, maxResults);
      if (results.length === 0) return `No matches for ${JSON.stringify(query)}.`;
      return truncateText(redactSecrets(results.join('\n')), MAX_OUTPUT);
    },
  };
}

function searchFilenames(query: string, ci: boolean, max: number, globs: string[], root: string): string {
  const files = walkFiles(root, { maxFiles: 5000 });
  const pattern = new RegExp(escapeRegExp(query), ci ? 'i' : '');
  const matches = files.filter((f) => {
    if (globs.length > 0 && !globsMatch(globs, f.rel)) return false;
    return pattern.test(f.rel);
  });
  if (matches.length === 0) return `No files whose path matches ${JSON.stringify(query)}.`;
  const shown = matches.slice(0, max);
  const extra = matches.length > shown.length ? `\n… and ${matches.length - shown.length} more` : '';
  return `Files matching ${JSON.stringify(query)}:\n${shown.map((f) => f.rel).join('\n')}${extra}`;
}

function searchFallback(root: string, query: string, ci: boolean, word: boolean, max: number): string[] {
  const files = walkFiles(root, { maxFiles: 5000 });
  const re = buildRegex(query, ci, word);
  const out: string[] = [];
  for (const file of files) {
    if (isProtectedPath(file.abs)) continue;
    if (file.size > 2_000_000) continue; // skip huge / binary-ish files
    let text: string;
    try {
      text = readFileSync(file.abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue; // binary
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && out.length < max; i++) {
      const line = lines[i] as string;
      if (re.test(line)) {
        out.push(`${file.rel}:${i + 1}: ${truncateText(line.trim(), 200)}`);
      }
    }
    if (out.length >= max) break;
  }
  return out;
}

function tryRipgrep(
  ctx: ToolContext,
  query: string,
  ci: boolean,
  word: boolean,
  globs: string[],
  max: number,
): { found: boolean; output: string } {
  const args = ['--line-number', '--no-heading', '--color=never', '--max-columns', '200'];
  if (ci) args.push('-i');
  if (word) args.push('-w');
  if (max) args.push('-m', String(max));
  for (const g of globs) args.push('-g', g);
  args.push('--', query, '.');

  let res;
  try {
    res = spawnSync('rg', args, { cwd: ctx.projectRoot, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 20_000 });
  } catch {
    return { found: false, output: '' };
  }
  if (!res || res.error || res.status === 2) return { found: false, output: '' };
  if (res.status === 1) return { found: true, output: 'No matches.' };
  return { found: true, output: (res.stdout as string) || 'No matches.' };
}

function buildRegex(query: string, ci: boolean, word: boolean): RegExp {
  const flags = ci ? 'i' : '';
  return word ? new RegExp(`\\b${escapeRegExp(query)}\\b`, flags) : new RegExp(escapeRegExp(query), flags);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globsMatch(globs: string[], rel: string): boolean {
  let matched = false;
  for (const g of globs) {
    const neg = g.startsWith('!');
    const pat = neg ? g.slice(1) : g;
    const re = new RegExp('^' + pat.split('*').join('[^/]*') + '$');
    if (re.test(rel)) matched = !neg;
  }
  return matched;
}
