/**
 * Interactive integration test for the GRACE TUI.
 *
 * Renders the REAL GraceApp with Ink against a mock terminal (fake stdin /
 * stdout with isTTY) and drives it with real keypress bytes — typing, Enter,
 * arrow keys, Esc, Ctrl+L, Ctrl+C — asserting that every interactive element
 * actually works: real input, submission, command palette, permission dialog
 * and exit.
 *
 * The stdin mock emulates a Node readable stream because Ink 7 reads input in
 * 'readable' mode (stdin.read()), not via 'data' events.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, test } from 'node:test';
import { render } from 'ink';
import { createElement as h } from 'react';
import { GraceApp } from '../src/cli/tui/app.ts';
import { TuiStore } from '../src/cli/tui/store.ts';
import { SLASH_COMMANDS } from '../src/cli/tui/commands.ts';
import type { TuiRunner } from '../src/cli/tui/runner.ts';

// ---------------------------------------------------------------------------
// Mock terminal
// ---------------------------------------------------------------------------

interface MockTerminal {
  stdin: EventEmitter & { isTTY: boolean; setRawMode: (v: boolean) => void; read: () => Buffer | null };
  stdout: EventEmitter & { isTTY: boolean; columns: number; rows: number; write: (d: string) => void };
  stderr: EventEmitter & { isTTY: boolean; write: (d: string) => void };
  /** All bytes written since the last flush. */
  flush: () => string;
  /** Push keypress bytes into the input stream. */
  press: (seq: string) => void;
}

function makeTerminal(columns = 100, rows = 30): MockTerminal {
  let buffer = '';
  let inputBuffer: Buffer[] = [];

  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns,
    rows,
    write: (d: string) => {
      buffer += d;
    },
  });
  const stderr = Object.assign(new EventEmitter(), { isTTY: true, write: () => undefined });

  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => true,
    pause: () => undefined,
    resume: () => undefined,
    setEncoding: () => undefined,
    ref: () => undefined,
    unref: () => undefined,
    read: () => (inputBuffer.length > 0 ? (inputBuffer.shift() as Buffer) : null),
  });

  return {
    stdin,
    stdout,
    stderr,
    flush: () => {
      const out = buffer;
      buffer = '';
      return out;
    },
    press: (seq: string) => {
      inputBuffer.push(Buffer.from(seq, 'utf8'));
      stdin.emit('readable');
    },
  };
}

/** Keypress bytes in raw mode (what a terminal sends). */
const KEYS = {
  enter: '\r',
  up: '\u001b[A',
  down: '\u001b[B',
  left: '\u001b[D',
  right: '\u001b[C',
  esc: '\u001b',
  tab: '\t',
  backspace: '\x7f',
  ctrlC: '\x03',
  ctrlL: '\x0c',
};

/** Strip ANSI escapes so assertions read the visible text. */
function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/** A stub runner that records interactions instead of running the agent. */
function makeStubRunner(store: TuiStore): {
  runner: TuiRunner;
  calls: { type: string; text: string }[];
  permissions: boolean[];
} {
  const calls: { type: string; text: string }[] = [];
  const permissions: boolean[] = [];
  const runner = {
    isBusy: () => false,
    cancelTask: () => undefined,
    runTask: async (input: string) => {
      calls.push({ type: 'task', text: input });
      store.push('system', `stub: received "${input}"`);
    },
    runSlash: async (raw: string) => {
      calls.push({ type: 'slash', text: raw });
      store.push('console', `stub: slash ${raw}`);
      return false;
    },
    askPermission: async (cmd: string, reasons: string[]) => {
      const allowed = await store.askPermission(cmd, reasons);
      permissions.push(allowed);
      return allowed;
    },
    rememberPrefix: () => undefined,
    openModelPicker: async () => undefined,
    openProviderPicker: () => undefined,
    submitAuth: async () => undefined,
    refreshInfo: () => undefined,
    getRuntime: () => null as never,
    setRuntime: () => undefined,
    makeRuntime: (r: string) => r as never,
  } as unknown as TuiRunner;
  return { runner, calls, permissions };
}

/**
 * Let Ink's throttled frame writer flush and its 20ms pending-escape parser
 * deliver a lone ESC (both are timer-based).
 */
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 40));
}

async function type(term: MockTerminal, text: string): Promise<void> {
  for (const ch of text) term.press(ch);
  await tick();
}

function boot(term: MockTerminal, store: TuiStore, runner: TuiRunner, onExit?: () => void): { app: ReturnType<typeof render> } {
  const app = render(h(GraceApp, { store, runner, onExit: onExit ?? (() => undefined) }), {
    stdin: term.stdin as never,
    stdout: term.stdout as never,
    stderr: term.stderr as never,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
    maxFps: 1000,
  });
  active.push(app);
  return { app };
}

const active: Array<{ unmount: () => void }> = [];
after(() => {
  for (const a of active.splice(0)) {
    try {
      a.unmount();
    } catch {
      // already unmounted
    }
  }
});

function freshStore(): TuiStore {
  return new TuiStore({
    version: '0.1.0',
    workspace: 'C:\\work\\app',
    provider: 'NVIDIA NIM',
    providerAvailable: true,
    model: 'qwen/qwen2.5-coder-32b-instruct',
    session: 'Local mode',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('interactive: typing renders in the input, Enter submits a real task', async () => {
  const store = freshStore();
  const term = makeTerminal();
  const stub = makeStubRunner(store);
  boot(term, store, stub.runner);
  await tick();

  const first = plain(term.flush());
  assert.match(first, /██████╗/, 'home shows the GRACE logo from GRACE_logo.txt');
  assert.match(first, /A I\s+C O D I N G\s+A G E N T/, 'home shows the muted subtitle under the logo');
  assert.match(first, /C:\\work\\app/, 'workspace is real');

  await type(term, 'fix the login bug');
  assert.match(plain(term.flush()), /fix the login bug/, 'typed text appears in the input');

  term.press(KEYS.enter);
  await tick();
  const afterSubmit = plain(term.flush());
  assert.deepEqual(stub.calls, [{ type: 'task', text: 'fix the login bug' }], 'Enter submitted the task');
  assert.match(afterSubmit, /stub: received "fix the login bug"/, 'the reply rendered in the activity feed');
});

test('interactive: slash palette opens on "/", filters, and Enter runs the selected command', async () => {
  const store = freshStore();
  const term = makeTerminal();
  const stub = makeStubRunner(store);
  boot(term, store, stub.runner);
  await tick();
  term.flush();

  await type(term, '/');
  const open = plain(term.flush());
  assert.match(open, /Commands/, 'palette opens on a lone slash');
  assert.match(open, /\/help/, 'palette lists real commands');

  // Type "/mod" → only /model matches; Enter runs the selected command.
  await type(term, 'mod');
  assert.match(plain(term.flush()), /\/model/, 'filter shows the matching command');
  term.press(KEYS.enter);
  await tick();
  assert.ok(stub.calls.some((c) => c.type === 'slash' && c.text === '/model'), 'Enter executed the selected command');

  // A full command with args runs verbatim.
  await type(term, '/clear');
  term.press(KEYS.enter);
  await tick();
  assert.ok(stub.calls.some((c) => c.type === 'slash' && c.text === '/clear'), 'typed command ran verbatim');
});

test('interactive: permission dialog pauses until y/n is pressed', async () => {
  const store = freshStore();
  const term = makeTerminal();
  const stub = makeStubRunner(store);
  boot(term, store, stub.runner);
  term.flush();

  // A task asks for permission — the dialog opens and the agent waits.
  let resolved = false;
  const askPromise = stub.runner.askPermission('npm install jsonwebtoken', ['flagged']).then(() => {
    resolved = true;
  });
  await tick();
  assert.equal(resolved, false, 'agent is paused while the dialog is open');
  const dialogFrame = plain(term.flush());
  assert.match(dialogFrame, /Permission required/, 'dialog renders');
  assert.match(dialogFrame, /npm install jsonwebtoken/, 'dialog shows the real command');

  // Esc denies.
  term.press(KEYS.esc);
  await askPromise;
  assert.equal(resolved, true);
  assert.deepEqual(stub.permissions, [false]);

  // 'y' allows.
  const p2 = stub.runner.askPermission('npm install x', ['flagged']);
  await tick();
  term.press('y');
  assert.equal(await p2, true);
  assert.deepEqual(stub.permissions, [false, true]);
});

test('interactive: Ctrl+L clears activity, Esc clears input, Ctrl+C exits', async () => {
  const store = freshStore();
  const term = makeTerminal();
  const stub = makeStubRunner(store);
  let exited = 0;
  const app = render(h(GraceApp, { store, runner: stub.runner, onExit: () => {
    exited += 1;
    app.unmount();
  } }), {
    stdin: term.stdin as never,
    stdout: term.stdout as never,
    stderr: term.stderr as never,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
    maxFps: 1000,
  });
  active.push(app);
  term.flush();

  // Some activity + typed text.
  store.push('console', 'old output line');
  await type(term, 'draft');
  assert.match(plain(term.flush()), /draft/, 'typing renders');

  // Ctrl+L clears the activity feed (input is untouched).
  term.press(KEYS.ctrlL);
  await tick();
  assert.equal(store.items.length, 0, 'Ctrl+L cleared the feed');
  assert.equal(store.input, 'draft', 'Ctrl+L leaves the input alone');

  // Esc clears the input.
  term.press(KEYS.esc);
  await tick();
  assert.equal(store.input, '', 'Esc cleared the input');

  // Typing again starts a fresh line.
  await type(term, 'abc');
  assert.equal(store.input, 'abc');

  // Ctrl+C while idle exits.
  term.press(KEYS.ctrlC);
  await tick();
  assert.equal(exited, 1, 'Ctrl+C requested exit');
});

test('interactive: home shortcuts focus via Tab, arrows select, Enter runs the real command', async () => {
  const store = freshStore();
  const term = makeTerminal();
  const stub = makeStubRunner(store);
  boot(term, store, stub.runner);
  term.flush();

  // Tab focuses the shortcut row (/help), → selects /status, Enter runs it.
  term.press(KEYS.tab);
  await tick();
  term.press(KEYS.right);
  await tick();
  term.press(KEYS.enter);
  await tick();

  assert.ok(
    stub.calls.some((c) => c.type === 'slash' && c.text === '/status'),
    'Enter executed the selected shortcut as a real slash command',
  );

  // Typing while the row is focused returns to the input and inserts.
  store.clearActivity();
  term.press(KEYS.tab);
  await tick();
  await type(term, 'fix auth');
  assert.equal(store.input, 'fix auth', 'typing from the shortcut row lands in the input');
});

test('interactive: the palette command table is complete and real', () => {
  const names = SLASH_COMMANDS.map((c) => c.name);
  for (const expected of ['/help', '/status', '/model', '/provider', '/cd', '/diff', '/clear', '/reset', '/undo', '/debug', '/login', '/register', '/logout', '/whoami', '/exit']) {
    assert.ok(names.includes(expected), `${expected} is a real command`);
  }
});
