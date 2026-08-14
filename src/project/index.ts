import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { detectProject } from './detect.ts';
import { walkFiles } from './walker.ts';

/**
 * Lightweight repository index (Project Scout, GRACE coordinator).
 *
 * Gives the coordinator structural knowledge of the repository (layout, key
 * files, entrypoints, test framework, important symbols) without re-reading
 * the whole repo on every task. The index is rebuilt lazily whenever the
 * fingerprint changes (new/changed files or config), so it stays fresh while
 * the agent edits files.
 */

export interface ProjectIndex {
  root: string;
  builtAt: number;
  /** Prebuilt compact text handed to the planner and repo-aware agents. */
  summary: string;
  fileCount: number;
  dirCount: number;
  topLevel: string[];
  keyFiles: string[];
  entrypoints: string[];
  testFramework: string | null;
  testCommand: string | null;
  buildCommand: string | null;
  packageManager: string | null;
  languages: string[];
  sourceDirs: string[];
  importantSymbols: Array<{ file: string; symbols: string[] }>;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.zeesh', '.myagent', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.cache', 'coverage']);
const KEY_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.rb', '.php']);
const MAX_WALK_FILES = 3_000;
const MAX_WALK_DEPTH = 8;

function tryRead(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Cheap structural fingerprint: name/mtime of files and dirs up to depth 3,
 * plus the package.json contents. Any file added/removed/renamed or any
 * config edit changes the fingerprint, triggering an index rebuild.
 */
function computeFingerprint(root: string): string {
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let scanned = 0;

  while (stack.length > 0 && scanned < 5_000) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    entries.sort();
    for (const name of entries) {
      if (scanned >= 5_000) break;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        out.push(`d:${name}`);
        if (depth < 3) stack.push({ dir: abs, depth: depth + 1 });
      } else if (st.isFile()) {
        out.push(`f:${name}:${st.size}:${st.mtimeMs}`);
      }
      scanned += 1;
    }
  }

  const pkg = tryRead(join(root, 'package.json'));
  if (pkg) out.push(`pkg:${pkg}`);
  return out.join('|');
}

function detectTestFramework(pkg: Record<string, unknown> | null, testCommand: string | null): string | null {
  if (!pkg) return testCommand ?? null;
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const all = Object.values(scripts).join(' ').toLowerCase();
  const order: Array<[RegExp, string]> = [
    [/vitest/, 'vitest'],
    [/jest/, 'jest'],
    [/mocha/, 'mocha'],
    [/ava\b/, 'ava'],
    [/playwright/, 'playwright'],
    [/cypress/, 'cypress'],
    [/node --test|node:test/, 'node:test'],
    [/pytest/, 'pytest'],
    [/go test/, 'go test'],
    [/cargo test/, 'cargo test'],
  ];
  for (const [re, name] of order) if (re.test(all)) return name;
  return testCommand ?? null;
}

function extractSymbols(content: string): string[] {
  const symbols: string[] = [];
  const re = /export\s+(?:async\s+)?(?:function|class|const|let|interface|type)\s+([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null && symbols.length < 20) {
    const name = m[1] ?? m[2];
    if (name) symbols.push(name);
  }
  return [...new Set(symbols)];
}

function buildIndex(root: string): ProjectIndex {
  const info = detectProject(root);
  const files = walkFiles(root, { maxFiles: MAX_WALK_FILES, maxDepth: MAX_WALK_DEPTH });

  const topLevel: string[] = [];
  const sourceDirs = new Set<string>();
  const fileExtCount = new Map<string, number>();
  try {
    for (const name of readdirSync(root)) {
      if (SKIP_DIRS.has(name)) continue;
      topLevel.push(name);
    }
  } catch {
    /* ignore */
  }
  topLevel.sort();

  for (const f of files) {
    const ext = f.rel.includes('.') ? f.rel.slice(f.rel.lastIndexOf('.')) : '';
    fileExtCount.set(ext, (fileExtCount.get(ext) ?? 0) + 1);
    const dir = f.rel.includes('/') ? f.rel.slice(0, f.rel.indexOf('/')) : null;
    if (dir) sourceDirs.add(dir);
  }

  const pkgRaw = tryRead(join(root, 'package.json'));
  let pkg: Record<string, unknown> | null = null;
  try {
    pkg = pkgRaw ? (JSON.parse(pkgRaw) as Record<string, unknown>) : null;
  } catch {
    pkg = null;
  }

  const entrypoints: string[] = [];
  if (pkg) {
    const bin = pkg.bin;
    if (typeof bin === 'string') entrypoints.push(bin);
    else if (bin && typeof bin === 'object') entrypoints.push(...Object.values(bin).filter((v): v is string => typeof v === 'string'));
    if (typeof pkg.main === 'string') entrypoints.push(pkg.main);
  }
  for (const candidate of ['src/index.ts', 'src/index.js', 'index.ts', 'index.js', 'main.py', 'app.py']) {
    if (entrypoints.includes(candidate)) continue;
    try {
      if (statSync(join(root, candidate)).isFile()) entrypoints.push(candidate);
    } catch {
      /* not present */
    }
  }

  const keyFiles = [...info.configFiles];
  for (const e of entrypoints) if (!keyFiles.includes(e)) keyFiles.push(e);
  const sourceFiles = files
    .filter((f) => KEY_EXTENSIONS.has(f.rel.slice(f.rel.lastIndexOf('.'))))
    .sort((a, b) => a.rel.length - b.rel.length)
    .slice(0, 30);
  for (const sf of sourceFiles) if (!keyFiles.includes(sf.rel)) keyFiles.push(sf.rel);
  keyFiles.sort();

  const importantSymbols: Array<{ file: string; symbols: string[] }> = [];
  for (const f of sourceFiles.slice(0, 15)) {
    const content = tryRead(f.abs)?.slice(0, 64_000) ?? '';
    const symbols = extractSymbols(content);
    if (symbols.length > 0) importantSymbols.push({ file: f.rel, symbols: symbols.slice(0, 12) });
  }

  const testFramework = detectTestFramework(pkg, info.testCommand);
  const dominantExt = [...fileExtCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const deps = detectDependencies(root, pkg);

  const summary = [
    `${info.type}${info.framework ? `/${info.framework}` : ''} project · pm: ${info.packageManager}${info.languages.length ? ` · languages: ${info.languages.join('+')}` : ''}${dominantExt ? ` · dominant: ${dominantExt}` : ''}`,
    `Test: ${info.testCommand ?? '—'}${info.buildCommand ? ` · Build: ${info.buildCommand}` : ''} · framework: ${testFramework ?? '—'}`,
    `Entrypoints: ${entrypoints.slice(0, 5).join(', ') || '—'}`,
    `Files: ${files.length} · top-level: ${topLevel.slice(0, 12).join(', ')}`,
    `Key files: ${keyFiles.slice(0, 10).join(', ')}`,
    deps.length > 0 ? `Deps: ${deps.slice(0, 14).join(', ')}` : '',
    importantSymbols.length > 0
      ? `Symbols: ${importantSymbols.slice(0, 6).map((s) => `${s.file} (${s.symbols.slice(0, 6).join(', ')})`).join('; ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    root,
    builtAt: Date.now(),
    summary,
    fileCount: files.length,
    dirCount: sourceDirs.size + topLevel.length,
    topLevel,
    keyFiles: keyFiles.slice(0, 25),
    entrypoints,
    testFramework,
    testCommand: info.testCommand,
    buildCommand: info.buildCommand,
    packageManager: info.packageManager,
    languages: info.languages,
    sourceDirs: [...sourceDirs],
    importantSymbols,
  };
}

/**
 * Detect the project's declared dependencies so the model knows the framework
 * up front (no "search for Flask / FastAPI" loops). Reads package.json,
 * requirements.txt and pyproject.toml dependency declarations.
 */
function detectDependencies(root: string, pkg: Record<string, unknown> | null): string[] {
  const out = new Set<string>();

  if (pkg) {
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = pkg[section];
      if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
        for (const name of Object.keys(deps as Record<string, unknown>)) out.add(name);
      }
    }
  }

  const req = tryRead(join(root, 'requirements.txt'));
  if (req) {
    for (const raw of req.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('-') || line.startsWith('.')) continue;
      out.add(line.split(/[=<>\[;\s]/)[0] ?? line);
    }
  }

  const pyproject = tryRead(join(root, 'pyproject.toml'));
  if (pyproject) {
    for (const re of [/^dependencies\s*=\s*\[([\s\S]*?)\]/m, /^\[tool\.poetry\.dependencies\][\s\S]*?$/m]) {
      const m = pyproject.match(re);
      if (!m) continue;
      const block = m[1] ?? m[0];
      const quoted = block.matchAll(/(?:^|[,\n])\s*["']([A-Za-z0-9_.-]+)["']/g);
      for (const q of quoted) out.add(q[1] as string);
    }
  }

  return [...out].filter((d) => !d.includes(' ')).sort();
}

/** Maintained, fingerprint-cached repository index. */
export class ProjectIndexService {
  private readonly root: string;
  private cache: ProjectIndex | null = null;
  private fingerprint: string | null = null;

  constructor(root: string) {
    this.root = root;
  }

  /** Current index — rebuilt automatically when the repository changed. */
  get(): ProjectIndex {
    const fp = computeFingerprint(this.root);
    if (this.cache && fp === this.fingerprint) return this.cache;
    this.cache = buildIndex(this.root);
    this.fingerprint = fp;
    return this.cache;
  }

  /** Force a rebuild on the next get() (e.g. after the editor ran). */
  invalidate(): void {
    this.cache = null;
    this.fingerprint = null;
  }
}
