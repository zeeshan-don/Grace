/** Render the redesigned TUI to text at several sizes (visual preview only). */
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { createElement as h } from 'react';
import { TuiStore } from '../src/cli/tui/store.ts';
import { GraceApp } from '../src/cli/tui/app.ts';
import type { TuiRunner } from '../src/cli/tui/runner.ts';

function freshStore(): TuiStore {
  return new TuiStore({
    version: '0.1.0',
    workspace: 'D:\\Projects\\grace',
    provider: 'NVIDIA NIM',
    providerAvailable: true,
    model: 'openai/gpt-oss-20b',
    session: 'Local mode',
  });
}

const stubRunner = {
  isBusy: () => false,
  cancelTask: () => undefined,
  runTask: async () => undefined,
  runSlash: async () => false,
  askPermission: async () => false,
  rememberPrefix: () => undefined,
  openModelPicker: async () => undefined,
  openProviderPicker: () => undefined,
  submitAuth: async () => undefined,
  refreshInfo: () => undefined,
  getRuntime: () => null,
  setRuntime: () => undefined,
  makeRuntime: (r: string) => r,
} as unknown as TuiRunner;

async function frame(columns: number, rows: number, st: TuiStore): Promise<string> {
  let buffer = '';
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
    read: () => null,
  });
  const app = render(h(GraceApp, { store: st, runner: stubRunner, onExit: () => app.unmount() }), {
    stdin: stdin as never,
    stdout: stdout as never,
    stderr: stderr as never,
    exitOnCtrlC: false,
    patchConsole: false,
    interactive: true,
    maxFps: 1000,
  });
  await new Promise((r) => setTimeout(r, 60));
  app.unmount();
  return buffer.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\n+$/, '');
}

const home = freshStore();
console.log('===== HOME 120x30 =====');
console.log(await frame(120, 30, home));

const home80 = freshStore();
console.log('\n===== HOME 80x24 =====');
console.log(await frame(80, 24, home80));

const homeShort = freshStore();
console.log('\n===== HOME 100x17 (short — status hides) =====');
console.log(await frame(100, 17, homeShort));

const homeNarrow = freshStore();
console.log('\n===== HOME 48x24 (narrow) =====');
console.log(await frame(48, 24, homeNarrow));

const homeTiny = freshStore();
console.log('\n===== HOME 32x12 (tiny) =====');
console.log(await frame(32, 12, homeTiny));

const busy = freshStore();
busy.mode = 'session';
busy.push('user', 'Add authentication to this project');
busy.push('progress', 'Exploring project structure');
busy.push('tool', 'Reading package.json');
busy.push('tool', 'Searching files · query: auth');
busy.push('success', 'Found existing structure');
busy.push('progress', 'Editing src/auth.ts');
busy.setBusy(true);
console.log('\n===== SESSION 100x26 (busy) =====');
console.log(await frame(100, 26, busy));

const done = freshStore();
done.mode = 'session';
done.push('user', 'Add authentication to this project');
done.push('progress', 'Exploring project structure');
done.push('tool', 'Reading package.json');
done.push('file', 'src/auth.ts');
done.push('result', '✓ Done');
done.push('result', 'Added login, sessions and a token endpoint.');
done.push('result', 'Updated:');
done.push('result', '  + src/auth/login.ts');
done.push('result', '  M src/auth/session.ts');
done.push('result', 'Validation:');
done.push('result', '  ✓ Tests — 215/215 passed');
done.push('result', '  18.4s · 5 tool calls');
console.log('\n===== SESSION 100x26 (done) =====');
console.log(await frame(100, 26, done));
