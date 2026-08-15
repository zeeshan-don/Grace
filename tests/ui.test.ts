/**
 * Unit tests for the GRACE terminal UI layer (src/cli/ui).
 *
 * Covers the capability-aware symbol fallback, the coordinator progress
 * renderer (flat, parallel-tree, failure, live redraw), structured result
 * sections, file-change classification, long-output collapsing, the /model
 * and /status panels, the prompt box and verbose mode. Everything here is
 * pure rendering — no provider or backend involved.
 *
 * Most tests run with ZEESH_UNICODE=1 so glyph assertions are deterministic
 * regardless of platform/TTY; the ASCII fallback and capability-detection
 * paths are tested inside explicit env overrides.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { CoordinatorEvent, CoordinatorRunResult, SubagentResult } from '../src/agents/types.ts';
import type { AIProvider } from '../src/providers/types.ts';
import type { Runtime } from '../src/runtime.ts';
import { box } from '../src/cli/ui/box.ts';
import { ProgressRenderer } from '../src/cli/ui/progress.ts';
import {
  classifyFileChanges,
  collapseLines,
  renderError,
  renderModelPanel,
  renderStatusPanel,
  renderTaskResult,
  type StatusPanelInfo,
} from '../src/cli/ui/results.ts';
import { stripAnsi, supportsUnicode, symbols } from '../src/cli/ui/theme.ts';
import { isVerbose, setVerbose, toggleVerbose } from '../src/cli/verbose.ts';

const SAVED_ENV: Record<string, string | undefined> = {};
for (const k of ['ZEESH_UNICODE', 'ZEESH_ASCII', 'WT_SESSION', 'NO_COLOR']) {
  SAVED_ENV[k] = process.env[k];
}

// Deterministic glyphs for the whole suite (env is read at call time).
process.env.ZEESH_UNICODE = '1';

after(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Run a callback under an env override, restoring afterwards. */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Symbols & capability detection
// ---------------------------------------------------------------------------

test('symbols: unicode glyphs', () => {
  const s = symbols();
  assert.equal(s.check, '✓');
  assert.equal(s.cross, '✗');
  assert.equal(s.arrow, '→');
  assert.equal(s.bullet, '·');
  assert.equal(s.cornerTl, '┌');
  assert.equal(s.cornerBl, '└');
  assert.equal(s.mid, '├');
});

test('symbols: ASCII fallback with ZEESH_ASCII=1', () => {
  withEnv({ ZEESH_ASCII: '1', ZEESH_UNICODE: undefined }, () => {
    const s = symbols();
    assert.equal(s.check, '[ok]');
    assert.equal(s.cross, '[x]');
    assert.equal(s.arrow, '->');
    assert.equal(s.bullet, '-');
    assert.equal(s.cornerTl, '+');
    assert.equal(s.cornerBl, '+');
  });
});

test('supportsUnicode: win32 without a modern-terminal marker falls back to ASCII', () => {
  withEnv({ ZEESH_ASCII: undefined, ZEESH_UNICODE: undefined, WT_SESSION: undefined }, () => {
    assert.equal(supportsUnicode('win32'), false);
    assert.equal(supportsUnicode('linux'), true);
    assert.equal(supportsUnicode('darwin'), true);
  });
});

test('supportsUnicode: modern terminal markers enable Unicode on Windows', () => {
  withEnv({ ZEESH_ASCII: undefined, ZEESH_UNICODE: undefined, WT_SESSION: '1' }, () => {
    assert.equal(supportsUnicode('win32'), true);
  });
});

// ---------------------------------------------------------------------------
// Progress renderer
// ---------------------------------------------------------------------------

/** A realistic primary-agent run: working line → status bullets → done. */
function scriptedRun(): CoordinatorEvent[] {
  return [
    { type: 'route', route: 'coding' },
    { type: 'step-start', step: 1, total: 1 },
    { type: 'agent-start', role: 'editor', label: 'Grace' },
    { type: 'working' },
    { type: 'status', message: '→ read_file src/auth/login.ts' },
    { type: 'status', message: '→ edit_file src/auth/login.ts' },
    { type: 'status', message: '→ run_command npm test' },
    { type: 'agent-done', role: 'editor', label: 'Grace', status: 'completed', summary: 'Authentication added' },
    { type: 'done' },
  ];
}

function runThrough(events: CoordinatorEvent[], opts: { live?: boolean; verbose?: boolean; providerLabel?: string; model?: string } = {}): string {
  const writes: string[] = [];
  const renderer = new ProgressRenderer({ out: { write: (t) => writes.push(t) }, live: false, ...opts });
  for (const e of events) renderer.event(e);
  renderer.end();
  return writes.join('');
}

test('progress: non-live output is deterministic — working line, done (tool bullets are debug-only)', () => {
  const out = runThrough(scriptedRun(), { providerLabel: 'NVIDIA NIM', model: 'openai/gpt-oss-20b' });
  const lines = out.split('\n').filter(Boolean);
  // Normal mode hides ALL internal tool activity — only the working line and
  // the finished summary remain.
  assert.deepEqual(lines, ['  · Grace is working…', '  → Grace ✓ — Authentication added']);
  assert.ok(!out.includes('read_file'), 'tool activity is hidden in normal mode');
  assert.ok(!out.includes('Project Scout'), 'no committee of agents is printed');
  assert.ok(!out.includes('NVIDIA NIM'), 'provider/model are debug-only (see /status)');
  // Verbose mode shows the tool-status bullets.
  const verboseOut = runThrough(scriptedRun(), { verbose: true, providerLabel: 'NVIDIA NIM', model: 'openai/gpt-oss-20b' });
  assert.match(verboseOut, /• → read_file src\/auth\/login\.ts/);
  assert.match(verboseOut, /• → edit_file src\/auth\/login\.ts/);
  assert.match(verboseOut, /• → run_command npm test/);
});

test('progress: verbose mode adds the provider header', () => {
  const out = runThrough(scriptedRun(), { verbose: true, providerLabel: 'NVIDIA NIM', model: 'openai/gpt-oss-20b' });
  assert.match(out, /Grace · NVIDIA NIM · openai\/gpt-oss-20b/);
});

test('progress: failed and unavailable agents render ✗ and ! marks', () => {
  const events: CoordinatorEvent[] = [
    { type: 'route', route: 'coding' },
    { type: 'step-start', step: 1, total: 1 },
    { type: 'agent-start', role: 'editor', label: 'Grace' },
    { type: 'working' },
    { type: 'agent-done', role: 'editor', label: 'Grace', status: 'failed', summary: 'crash', error: 'The provider rejected the request' },
    { type: 'agent-start', role: 'browser-use', label: 'Browser' },
    { type: 'agent-done', role: 'browser-use', label: 'Browser', status: 'unavailable', summary: 'No browser backend' },
    { type: 'done' },
  ];
  const out = runThrough(events);
  assert.match(out, /→ Grace ✗ — The provider rejected the request/);
  // Specialist names are debug-only — the unavailable agent shows its mark.
  assert.match(out, /→ ! — No browser backend/);
  assert.ok(!out.includes('Browser'), 'no specialist name in normal mode');
});

test('progress: a greeting renders nothing at all', () => {
  const writes: string[] = [];
  const renderer = new ProgressRenderer({ out: { write: (t) => writes.push(t) }, live: false });
  renderer.event({ type: 'route', route: 'conversation' });
  renderer.event({ type: 'done' });
  renderer.end();
  assert.equal(writes.join(''), '', 'no progress circus for a greeting');
});

test('progress: specialist agent names are debug-only (normal mode hides them)', () => {
  const events: CoordinatorEvent[] = [
    { type: 'route', route: 'complex' },
    { type: 'planning' },
    { type: 'step-start', step: 1, total: 2 },
    { type: 'agent-start', role: 'thinker', label: 'Thinker' },
    { type: 'agent-done', role: 'thinker', label: 'Thinker', status: 'completed', summary: 'Strategy ready' },
    { type: 'step-start', step: 2, total: 2 },
    { type: 'agent-start', role: 'editor', label: 'Grace' },
    { type: 'working' },
    { type: 'agent-done', role: 'editor', label: 'Grace', status: 'completed', summary: 'Implemented' },
    { type: 'done' },
  ];
  // Normal mode: no internal agent ceremony (planning included), only the
  // finished summaries.
  const out = runThrough(events);
  assert.ok(!out.includes('Planning'), 'planning is debug-only in normal mode');
  assert.ok(!out.includes('Thinker'), 'specialist names are debug-only');
  assert.match(out, /→ ✓ — Strategy ready/);
  assert.match(out, /→ Grace ✓ — Implemented/);
  // Debug mode: planning + specialist start lines + names appear.
  const verboseOut = runThrough(events, { verbose: true });
  assert.match(verboseOut, /· Planning…/);
  assert.match(verboseOut, /· Thinker…/);
  assert.match(verboseOut, /→ Thinker ✓ — Strategy ready/);
});

test('progress: verbose mode adds step headers', () => {
  const out = runThrough(scriptedRun(), { verbose: true });
  assert.match(out, /Step 1\/1/);
});

test('progress: live mode settles every line by end() (no pending leftovers)', () => {
  const writes: string[] = [];
  const renderer = new ProgressRenderer({ out: { write: (t) => writes.push(t) }, live: true, columns: 100 });
  for (const e of scriptedRun()) renderer.event(e);
  renderer.end();
  const all = writes.join('');
  // Live redraw used ANSI cursor control.
  assert.ok(all.includes('\x1b['), 'live redraw emits ANSI sequences');
  // The final write is the settled block and contains the primary agent once.
  const last = writes[writes.length - 1] as string;
  assert.match(last, /→ Grace ✓ — Authentication added/);
  const plain = last.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\[[0-9]+[AB]/g, '');
  // No AGENT/working line may remain pending after end().
  assert.ok(!/· Grace is working…/.test(plain), 'no pending working line after end()');
  assert.ok(!/· (Thinker|Grace)…/.test(plain), 'no pending agent lines remain after end()');
});

test('progress: ASCII fallback keeps the same structure with safe glyphs', () => {
  withEnv({ ZEESH_ASCII: '1', ZEESH_UNICODE: undefined }, () => {
    const out = runThrough(scriptedRun());
    assert.match(out, /-> Grace \[ok\] — Authentication added/);
    // Tool-status bullets are hidden in normal mode; verbose keeps them with
    // the ASCII '*' bullet.
    assert.ok(!out.includes('read_file'), 'tool activity is hidden in normal mode');
    const verboseOut = runThrough(scriptedRun(), { verbose: true });
    assert.match(verboseOut, /\* → read_file src\/auth\/login\.ts/);
  });
});

// ---------------------------------------------------------------------------
// Structured result sections
// ---------------------------------------------------------------------------

function fakeProvider(label = 'Groq'): AIProvider {
  return {
    id: 'groq',
    label,
    getModel: () => ({ id: 'llama-3.3-70b-versatile', contextWindow: 131072, supportedFeatures: ['tool_calls', 'json'] }),
    setModel: () => undefined,
    listModels: async () => [],
    chat: async () => ({ content: null, toolCalls: [], finishReason: 'stop' }),
    streamChat: async function* () {},
  } as unknown as AIProvider;
}

function fakeResult(overrides: Partial<CoordinatorRunResult> = {}): CoordinatorRunResult {
  return {
    task: 'Add auth',
    route: 'coding',
    plan: { steps: [{ agents: ['editor'], reason: 'Primary agent handles the task directly.' }] },
    results: [],
    finalAnswer: 'Implemented authentication.',
    changedFiles: [],
    iterations: 3,
    toolCalls: 5,
    metrics: { llmCalls: 3 },
    ...overrides,
  };
}

function fakeRuntime(root: string, provider: AIProvider | null = fakeProvider()): Runtime {
  return {
    root,
    project: { type: 'node', packageManager: 'npm', languages: ['TypeScript'], configFiles: ['package.json'], testCommand: 'npm test', buildCommand: 'npm run build' },
    session: { messageCount: 0, stats: { toolCalls: 0, runs: 0, inputTokens: 0, outputTokens: 0 }, clear: () => undefined } as unknown as Runtime['session'],
    undo: { count: 0, pendingChanges: () => [], undo: () => null } as unknown as Runtime['undo'],
    provider,
    providerError: null,
    tools: [],
    yes: false,
    ask: async () => false,
    model: 'llama-3.3-70b-versatile',
  } as unknown as Runtime;
}

test('results: success sections (updated files + compact footer, no noise)', () => {
  const runtime = fakeRuntime('C:\\work\\app');
  const result = fakeResult({ changedFiles: ['src/auth/login.ts', 'src/auth/session.ts'] });
  const out = renderTaskResult({ result, runtime, executionTimeMs: 18_400 });
  assert.match(out, /✓ Done/);
  assert.match(out, /Implemented authentication/);
  assert.match(out, /Updated:/);
  assert.match(out, /\+\s+src\/auth\/login\.ts/);
  assert.match(out, /\+\s+src\/auth\/session\.ts/);
  // Compact footer replaces the Provider/Time sections.
  assert.match(out, /18\.4s · 5 tool calls/);
  // No provider/model/follow-up noise after every task.
  assert.ok(!out.includes('Provider'), 'provider is /status territory');
  assert.ok(!out.includes('Suggested follow-ups'), 'no fake follow-ups');
  assert.ok(!out.includes('iteration(s)'), 'no iteration ceremony in normal mode');
  // No validation section when nothing verified the work.
  assert.ok(!out.includes('Validation'));
});

test('results: validation section reflects the test runner + reviewer', () => {
  const tester: SubagentResult = {
    agent: 'test-runner', label: 'Test Runner', status: 'completed',
    summary: '215/215 tests passed', files: [], changedFiles: [], findings: [], recommendations: [],
    iterations: 1, toolCalls: 1,
  };
  const reviewer: SubagentResult = {
    agent: 'code-reviewer', label: 'Code Reviewer', status: 'completed',
    summary: 'No critical issues', files: [], changedFiles: [], findings: [], recommendations: [],
    iterations: 1, toolCalls: 1,
  };
  const runtime = fakeRuntime('C:\\work\\app');
  const out = renderTaskResult({ result: fakeResult({ results: [tester, reviewer] }), runtime, executionTimeMs: 1000 });
  assert.match(out, /Validation:/);
  assert.match(out, /✓ Tests — 215\/215 tests passed/);
  assert.match(out, /✓ Review — No critical issues/);
});

test('results: failed task renders an error header', () => {
  const editor: SubagentResult = {
    agent: 'editor', label: 'Editor', status: 'failed',
    summary: 'The task failed: server boom (status 500)', error: 'server boom (status 500)',
    files: [], changedFiles: [], findings: [], recommendations: [], iterations: 1, toolCalls: 0,
  };
  const runtime = fakeRuntime('C:\\work\\app');
  const out = renderTaskResult({ result: fakeResult({ results: [editor], finalAnswer: 'The task failed: server boom (status 500)' }), runtime, executionTimeMs: 1000 });
  assert.match(out, /✗ Task not completed/);
  assert.match(out, /server boom/);
});

test('results: a secondary agent failing does not mislabel a completed task', () => {
  const editor: SubagentResult = {
    agent: 'editor', label: 'Editor', status: 'completed',
    summary: 'All implemented', files: [], changedFiles: ['src/a.ts'], findings: [], recommendations: [],
    iterations: 2, toolCalls: 4,
  };
  const researcher: SubagentResult = {
    agent: 'researcher', label: 'Researcher', status: 'failed',
    summary: 'could not reach docs', error: 'network unreachable',
    files: [], changedFiles: [], findings: [], recommendations: [], iterations: 1, toolCalls: 1,
  };
  const runtime = fakeRuntime('C:\\work\\app');
  const out = renderTaskResult({ result: fakeResult({ results: [researcher, editor] }), runtime, executionTimeMs: 1000 });
  assert.match(out, /✓ Done/);
  assert.ok(!out.includes('Task not completed'));
});

test('results: verbose adds plan, agent details and usage sections', () => {
  const runtime = fakeRuntime('C:\\work\\app');
  const result = fakeResult({
    plan: { steps: [{ agents: ['file-picker'], reason: 'find files' }, { agents: ['editor'], reason: 'implement' }] },
    results: [
      {
        agent: 'file-picker', label: 'File Picker', status: 'completed', summary: 'Found the files',
        files: ['src/a.ts'], changedFiles: [], findings: ['login lives in src/auth'], recommendations: [],
        iterations: 1, toolCalls: 2,
      },
    ],
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  });
  const out = renderTaskResult({ result, runtime, executionTimeMs: 1000, verbose: true });
  assert.match(out, /Plan/);
  assert.match(out, /1\. file-picker/);
  assert.match(out, /2\. editor/);
  assert.match(out, /Agent details/);
  assert.match(out, /File Picker ✓/);
  assert.match(out, /Usage/);
  assert.match(out, /100 tokens in · 50 tokens out · 150 total/);
});

test('results: secrets never appear (error block is a plain message)', () => {
  const err = renderError('The AI provider request failed.', 'Rate limit exceeded.');
  assert.match(err, /✗ The AI provider request failed\./);
  assert.match(err, /Rate limit exceeded\./);
  assert.ok(!/api[_-]?key|nvapi|sk-[a-z0-9]|gsk_/i.test(err), 'no credential-looking strings');
});

// ---------------------------------------------------------------------------
// File change classification
// ---------------------------------------------------------------------------

test('file changes: git status maps to + / M / - markers', () => {
  const gitStatus = [
    ' M src/auth/login.ts',
    'A  src/auth/dashboard.ts',
    '?? src/auth/newfile.ts',
    ' D tests/auth.test.ts',
  ].join('\n');
  const out = classifyFileChanges(
    ['src/auth/login.ts', 'src/auth/dashboard.ts', 'src/auth/newfile.ts', 'tests/auth.test.ts'],
    'C:\\work\\app',
    { isRepo: () => true, getStatus: () => gitStatus },
  );
  assert.deepEqual(out, [
    { status: 'M', path: 'src/auth/login.ts' },
    { status: 'A', path: 'src/auth/dashboard.ts' },
    { status: 'A', path: 'src/auth/newfile.ts' },
    { status: 'D', path: 'tests/auth.test.ts' },
  ]);
});

test('file changes: without git every change renders as added (+)', () => {
  const out = classifyFileChanges(['hello.py', 'src/app.ts'], 'C:\\work\\app', { isRepo: () => false });
  assert.deepEqual(out, [
    { status: 'A', path: 'hello.py' },
    { status: 'A', path: 'src/app.ts' },
  ]);
});

// ---------------------------------------------------------------------------
// Collapse
// ---------------------------------------------------------------------------

test('collapse: long output is truncated with a visible hidden-count notice', () => {
  const input = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const out = collapseLines(input, { max: 10 });
  assert.match(out, /line 0/);
  assert.match(out, /line 7/);
  assert.ok(!out.includes('line 8'), 'tail is hidden');
  assert.match(out, /\[92 line\(s\) hidden — use \/verbose to show\]/);
});

test('collapse: short output is fully indented, verbose lifts the cap', () => {
  const out = collapseLines('a\nb\nc');
  assert.deepEqual(out.split('\n'), ['  a', '  b', '  c']);
  const long = Array.from({ length: 450 }, (_, i) => `l${i}`).join('\n');
  const verbose = collapseLines(long, { max: 40, verbose: true });
  assert.ok(verbose.includes('l449'), 'verbose shows the tail');
});

// ---------------------------------------------------------------------------
// /model and /status panels
// ---------------------------------------------------------------------------

test('/model panel: structured provider/model/context rows', () => {
  const out = renderModelPanel({
    providerAvailable: true,
    providerLabel: 'NVIDIA NIM',
    servedVia: 'GRACE backend',
    model: 'qwen/qwen2.5-coder-32b-instruct',
    contextWindow: 131072,
  });
  assert.match(out, /Provider/);
  assert.match(out, /NVIDIA NIM ✓/);
  assert.match(out, /qwen\/qwen2\.5-coder-32b-instruct/);
  assert.match(out, /Context/);
  assert.match(out, /~131k tokens/);
  assert.match(out, /Served via/);
  assert.match(out, /GRACE backend/);
});

test('/model panel: no provider still renders cleanly', () => {
  const out = renderModelPanel({ providerAvailable: false, providerLabel: '', model: '', contextWindow: 0, providerError: 'not configured' });
  assert.match(out, /✗ not configured/);
});

test('/status panel: all sections render, non-repo handled', () => {
  const info: StatusPanelInfo = {
    project: {
      directory: 'C:\\work\\app',
      type: 'node · TypeScript',
      packageManager: 'npm',
      languages: ['TypeScript'],
      configFiles: ['package.json'],
      testCommand: 'npm test',
      buildCommand: 'npm run build',
    },
    git: { isRepo: false, branch: null, hasChanges: false, statusLines: 0 },
    provider: {
      available: true,
      error: null,
      label: 'NVIDIA NIM',
      servedVia: 'GRACE backend',
      model: 'qwen/qwen2.5-coder-32b-instruct',
      contextWindow: 131072,
    },
    session: { messages: 4, toolCalls: 2, runs: 1, inputTokens: 100, outputTokens: 50, undoSnapshots: 0 },
    freePlan: ['  Sessions:     1 / 6 used today'],
    runtime: { node: 'v24.0.0', platform: 'win32', stateDir: 'C:\\work\\app\\.zeesh' },
  };
  const out = renderStatusPanel(info);
  assert.match(out, /Project/);
  assert.match(out, /Directory/);
  assert.match(out, /Not a git repository/);
  assert.match(out, /NVIDIA NIM ✓/);
  assert.match(out, /qwen\/qwen2\.5-coder-32b-instruct/);
  assert.match(out, /Session/);
  assert.match(out, /Sessions:     1 \/ 6 used today/);
  assert.match(out, /Runtime/);
  assert.match(out, /win32/);
});

// ---------------------------------------------------------------------------
// Box helpers (startup logo only — there is no fake input box)
// ---------------------------------------------------------------------------

test('box: content longer than the width is truncated', () => {
  const out = box('x'.repeat(200), { width: 44 });
  const mid = out.split('\n')[1] as string;
  assert.ok(stripAnsi(mid).length <= 46, 'middle line is clipped to the box width');
  assert.match(mid, /…/);
});

// ---------------------------------------------------------------------------
// Verbose mode
// ---------------------------------------------------------------------------

test('verbose: toggle + flag state', () => {
  setVerbose(false);
  assert.equal(isVerbose(), false);
  assert.equal(toggleVerbose(), true);
  assert.equal(isVerbose(), true);
  setVerbose(false);
  assert.equal(isVerbose(), false);
});

// ---------------------------------------------------------------------------
// Git integration (real repo) — validation clean-tree line
// ---------------------------------------------------------------------------

test('results: validation shows a clean git tree when the repo is clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zeesh-ui-git-'));
  try {
    const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    if (init.status !== 0) return; // git unavailable — skip quietly
    const runtime = fakeRuntime(dir, null);
    const out = renderTaskResult({ result: fakeResult(), runtime, executionTimeMs: 500 });
    assert.match(out, /✓ Git — working tree clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
