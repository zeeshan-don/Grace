/**
 * Unit tests for the GRACE full-screen TUI layer (src/cli/tui).
 *
 * Covers the pure, renderer-independent logic — the store (input editing,
 * history, activity feed, scrolling, overlays), real model/provider discovery,
 * tool-event rendering, the command palette — plus a renderToString smoke test
 * proving the Ink components actually render.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { renderToString } from 'ink';
import { createElement as h } from 'react';
import type { AIProvider } from '../src/providers/types.ts';
import type { Runtime } from '../src/runtime.ts';
import { TuiStore } from '../src/cli/tui/store.ts';
import { friendlyTool } from '../src/cli/tui/runner.ts';
import { SLASH_COMMANDS } from '../src/cli/tui/commands.ts';
import { discoverModels, discoverProviders } from '../src/cli/tui/models.ts';
import { HomeScreen, ActivityPanel, InputLine } from '../src/cli/tui/components.ts';
import type { TuiInfo } from '../src/cli/tui/types.ts';

const SAVED_ENV: Record<string, string | undefined> = {};
for (const k of ['GROQ_API_KEY', 'HOME', 'USERPROFILE', 'ZEESH_UNICODE', 'NO_COLOR']) {
  SAVED_ENV[k] = process.env[k];
}

after(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function info(overrides: Partial<TuiInfo> = {}): TuiInfo {
  return {
    version: '0.1.0',
    workspace: 'C:\\work\\app',
    provider: 'NVIDIA NIM',
    providerAvailable: true,
    model: 'qwen/qwen2.5-coder-32b-instruct',
    session: 'Local mode',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Store: input editing
// ---------------------------------------------------------------------------

test('store: insert/backspace/delete edit at the cursor', () => {
  const s = new TuiStore(info());
  s.insert('hello');
  assert.equal(s.input, 'hello');
  s.moveLeft();
  s.moveLeft();
  s.insert('X'); // helXlo
  assert.equal(s.input, 'helXlo');
  s.backspace(); // hello
  assert.equal(s.input, 'hello');
  s.home();
  s.delete(); // ello
  assert.equal(s.input, 'ello');
  s.end();
  s.insert('!');
  assert.equal(s.input, 'ello!');
});

test('store: home/end and cursor bounds are safe', () => {
  const s = new TuiStore(info());
  s.insert('abc');
  s.moveLeft();
  s.moveLeft();
  s.moveLeft();
  s.moveLeft(); // clamped at 0
  assert.equal(s.cursor, 0);
  s.home();
  assert.equal(s.cursor, 0);
  s.end();
  assert.equal(s.cursor, 3);
  s.moveRight();
  s.moveRight();
  assert.equal(s.cursor, 3);
});

test('store: history up/down restores and clears', () => {
  const s = new TuiStore(info());
  s.setInput('first task');
  s.submitInput();
  s.setInput('second task');
  s.submitInput();
  assert.equal(s.input, '');
  s.historyUp();
  assert.equal(s.input, 'second task');
  s.historyUp();
  assert.equal(s.input, 'first task');
  s.historyUp(); // clamped
  assert.equal(s.input, 'first task');
  s.historyDown();
  assert.equal(s.input, 'second task');
  s.historyDown();
  assert.equal(s.input, ''); // back to a fresh line
});

// ---------------------------------------------------------------------------
// Store: activity + scrolling
// ---------------------------------------------------------------------------

test('store: push splits multi-line text into lines', () => {
  const s = new TuiStore(info());
  s.push('result', 'line one\nline two\n\nline three');
  assert.deepEqual(s.items.map((i) => i.text), ['line one', 'line two', 'line three']);
  assert.ok(s.items.every((i) => i.kind === 'result'));
});

test('store: scroll offset math follows the bottom and honors limits', () => {
  const s = new TuiStore(info());
  for (let i = 0; i < 50; i += 1) s.push('console', `line ${i}`);
  assert.equal(s.scroll, 0, 'starts following the bottom');
  s.scrollUp(5);
  assert.equal(s.scroll, 5);
  s.scrollUp(1000);
  assert.equal(s.scroll, 49, 'clamped to the top of the log');
  s.scrollDown(1000);
  assert.equal(s.scroll, 0, 'back to following');
});

test('store: activity is capped so long tasks cannot blow memory', () => {
  const s = new TuiStore(info());
  for (let i = 0; i < 3000; i += 1) s.push('console', `line ${i}`);
  assert.ok(s.items.length <= 2000);
  assert.equal(s.items[s.items.length - 1]?.text, 'line 2999', 'keeps the newest lines');
});

// ---------------------------------------------------------------------------
// Store: permission + overlays
// ---------------------------------------------------------------------------

test('store: permission dialog resolves with the answer', async () => {
  const s = new TuiStore(info());
  let resolved: boolean | null = null;
  const p = s.askPermission('npm install x', ['flagged']).then((a) => (resolved = a));
  assert.ok(s.permission, 'dialog opens');
  s.answerPermission(true);
  await p;
  assert.equal(resolved, true);
  assert.equal(s.permission, null, 'dialog closes');
});

test('store: picker filtering and selection', () => {
  const s = new TuiStore(info());
  let picked: string | null = null;
  s.openPicker(
    'model',
    'Models',
    [
      { value: 'a', label: 'model-a' },
      { value: 'b', label: 'model-b' },
    ],
    (opt) => (picked = opt.value),
    () => undefined,
  );
  s.pickerFilter('model-b');
  assert.deepEqual(s.picker?.options.map((o) => o.value), ['b']);
  s.pickerMove(-1); // wraps
  s.pickerMove(-1);
  assert.equal(s.picker?.selected, 0);
  s.pickerSelect();
  assert.equal(picked, 'b');
  assert.equal(s.picker, null);
});

test('store: palette rows filter by the first token', () => {
  const s = new TuiStore(info());
  s.setInput('/mod');
  assert.ok(s.palette, 'typing a slash command opens the palette');
  s.setPaletteCommands(SLASH_COMMANDS);
  const rows = s.paletteRows();
  assert.deepEqual(rows.map((c) => c.name), ['/model']);
  // Args are preserved: "/model groq" still matches /model.
  s.setInput('/model groq');
  assert.deepEqual(s.paletteRows().map((c) => c.name), ['/model']);
  s.clearInput();
  assert.equal(s.palette, null, 'clearing closes the palette');
});

// ---------------------------------------------------------------------------
// Store: login overlay
// ---------------------------------------------------------------------------

test('store: login overlay fields edit and mask', () => {
  const s = new TuiStore(info());
  s.openLogin('register', 'dev@example.com');
  assert.equal(s.login?.field, 'email');
  s.loginNextField();
  assert.equal(s.login?.field, 'password');
  s.loginType('h');
  s.loginType('i');
  assert.equal(s.login?.password, 'hi');
  s.loginBackspace();
  assert.equal(s.login?.password, 'h');
  s.loginNextField();
  assert.equal(s.login?.field, 'confirm', 'register has a confirm field');
  s.loginNextField();
  assert.equal(s.login?.field, 'email', 'wraps back to email');
});

// ---------------------------------------------------------------------------
// friendlyTool: human-readable tool activity (no raw JSON)
// ---------------------------------------------------------------------------

test('friendlyTool: transforms raw tool args into readable lines', () => {
  assert.equal(friendlyTool('read_file', { path: 'src/auth.ts' }), 'Reading src/auth.ts');
  assert.equal(friendlyTool('edit_file', { path: 'src/auth.ts' }), 'Editing src/auth.ts');
  assert.equal(friendlyTool('write_file', { path: 'src/new.ts' }), 'Writing src/new.ts');
  assert.equal(friendlyTool('search_files', { query: 'authentication' }), 'Searching files · query: authentication');
  assert.equal(friendlyTool('run_command', { command: 'npm test' }), 'Running npm test');
  assert.equal(friendlyTool('list_directory', { path: 'src' }), 'Listing directory src');
  assert.equal(friendlyTool('git_diff', {}), 'Checking git diff');
  assert.equal(friendlyTool('web_fetch', { url: 'https://example.com' }), 'Fetching https://example.com');
  assert.ok(!friendlyTool('run_command', { command: 'npm test' }).includes('{'), 'no raw JSON objects');
});

// ---------------------------------------------------------------------------
// Model/provider discovery (real data only)
// ---------------------------------------------------------------------------

function fakeProvider(opts: { id?: string; label?: string; live?: string[]; current?: string } = {}): AIProvider {
  return {
    id: opts.id ?? 'groq',
    label: opts.label ?? 'Groq (LPU)',
    getModel: () => ({ id: opts.current ?? 'model-x', contextWindow: 131072, supportedFeatures: ['tool_calls'] }),
    setModel: () => undefined,
    listModels: async () => opts.live ?? [],
    chat: async () => ({ content: null, toolCalls: [], finishReason: 'stop' }),
    streamChat: async function* () {},
  } as unknown as AIProvider;
}

function fakeRuntime(provider: AIProvider | null): Runtime {
  return {
    root: 'C:\\work\\app',
    project: { type: 'node', packageManager: 'npm', languages: ['TypeScript'], configFiles: ['package.json'], testCommand: null, buildCommand: null },
    session: {} as Runtime['session'],
    undo: {} as Runtime['undo'],
    provider,
    providerError: provider ? null : 'no provider',
    tools: [],
    yes: false,
    ask: async () => false,
    model: 'model-x',
  } as unknown as Runtime;
}

test('models: local Groq uses the live catalog when available', async () => {
  const provider = fakeProvider({ id: 'groq', live: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'], current: 'llama-3.3-70b-versatile' });
  const options = await discoverModels(fakeRuntime(provider));
  const ids = options.map((o) => o.value);
  assert.deepEqual(ids, ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b']);
  assert.equal(options.find((o) => o.current)?.value, 'llama-3.3-70b-versatile');
});

test('models: local Groq falls back to documented ids when the live list fails', async () => {
  const provider = fakeProvider({ id: 'groq', live: [], current: 'x' });
  const options = await discoverModels(fakeRuntime(provider));
  assert.ok(options.length > 0, 'documented table is not empty');
  assert.ok(options.every((o) => o.value.startsWith('openai/') || o.value.startsWith('llama-') || o.value.startsWith('qwen/')), 'only real Groq ids');
});

test('models: no provider yields an empty picker (no fake models)', async () => {
  const options = await discoverModels(fakeRuntime(null));
  assert.deepEqual(options, []);
});

test('models: providers list is empty when nothing is configured', () => {
  process.env.GROQ_API_KEY = '';
  assert.deepEqual(discoverProviders(fakeRuntime(null)), []);
});

// ---------------------------------------------------------------------------
// Render smoke tests (renderToString — no terminal needed)
// ---------------------------------------------------------------------------

test('render: home screen shows the logo, subtitle, workspace, model and session', () => {
  const s = new TuiStore(info());
  const out = renderToString(h(HomeScreen, { store: s }), { columns: 80 });
  // The GRACE logo from GRACE_logo.txt — first row and last row both render.
  assert.match(out, /██████╗/, 'the GRACE logo from GRACE_logo.txt renders');
  assert.match(out, /╚══════╝/, 'the last logo row renders');
  assert.match(out, /A I\s+C O D I N G\s+A G E N T/, 'muted subtitle under the logo');
  assert.match(out, /C:\\work\\app/, 'real workspace in the status row');
  assert.match(out, /Local mode/, 'real session in the status row');
  assert.match(out, /qwen\/qwen2\.5-code/, 'real model in the status row');
});

test('render: home status row shows the real free-plan quota when present', () => {
  const s = new TuiStore(info({ freePlan: 'Quota · Session 2/6 · 45m left · 1h used today' }));
  const out = renderToString(h(HomeScreen, { store: s }), { columns: 80 });
  assert.match(out, /Quota · Session 2\/6 · 45m left/, 'real quota line under the status row');
});

test('render: activity panel shows pushed lines and respects the height', () => {
  const s = new TuiStore(info());
  s.mode = 'session';
  for (let i = 0; i < 30; i += 1) s.push('console', `line ${i}`);
  const out = renderToString(h(ActivityPanel, { store: s, height: 6 }), { columns: 80 });
  const lines = out.split('\n').filter((l) => l.includes('line '));
  assert.ok(lines.length > 0 && lines.length <= 4, `window fits the height (got ${lines.length})`);
  assert.match(lines[lines.length - 1] as string, /line 29/, 'follows the bottom');
});

test('render: input line shows the typed text and a placeholder when empty', () => {
  const s = new TuiStore(info());
  let out = renderToString(h(InputLine, { store: s }), { columns: 60 });
  assert.match(out, /Ask me to build/);
  s.insert('fix the login');
  out = renderToString(h(InputLine, { store: s }), { columns: 60 });
  assert.match(out, /fix the login/);
  assert.match(out, /›/, 'the input prompt is a chevron, not a fake box');
});
