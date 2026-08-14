/**
 * TUI slash command handlers (GRACE full-screen interface).
 *
 * Every command is REAL — the same backend logic as the piped REPL. Output
 * from the shared command functions lands in the activity feed because the
 * TUI redirects console.log; commands with interactive surfaces (model /
 * provider pickers, login overlay, help, clear) are handled natively here.
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { cmdDiff, cmdModel, cmdProvider, cmdReset, cmdStatus, cmdUndo } from '../commands.ts';
import { cmdLogout, cmdWhoami } from '../authCommands.ts';
import { isVerbose, setVerbose, toggleVerbose } from '../verbose.ts';
import type { TuiRunner } from './runner.ts';
import type { TuiStore } from './store.ts';

/**
 * Execute a slash command. Returns true when Grace should exit.
 * `cmd` is the slash token (with leading '/'), `arg` the rest of the line.
 */
export async function handleTuiSlash(runner: TuiRunner, store: TuiStore, cmd: string, arg: string): Promise<boolean> {
  const runtime = runner.getRuntime();

  switch (cmd) {
    case '/help':
      store.openHelp();
      return false;

    case '/model':
      if (!arg.trim()) {
        await runner.openModelPicker();
      } else {
        await cmdModel(runtime, arg);
        runner.refreshInfo();
      }
      return false;

    case '/provider':
      if (!arg.trim()) {
        runner.openProviderPicker();
      } else {
        await cmdProvider(runtime, arg);
        runner.refreshInfo();
      }
      return false;

    case '/cd': {
      const dir = arg.trim();
      if (!dir) {
        store.push('error', 'Usage: /cd <directory>');
        return false;
      }
      const target = resolve(runtime.root, dir);
      let isDir = false;
      try {
        isDir = statSync(target).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        store.push('error', `Not a directory: ${target}`);
        return false;
      }
      const next = runner.makeRuntime(target);
      runner.setRuntime(next);
      runner.refreshInfo();
      store.push('success', 'Workspace changed.');
      store.push('info', `Workspace: ${next.root}`);
      return false;
    }

    case '/clear':
      store.clearActivity();
      return false;

    case '/login':
      store.openLogin('login', arg);
      return false;

    case '/register':
      store.openLogin('register', arg);
      return false;

    case '/status':
      await cmdStatus(runtime);
      return false;

    case '/diff':
      await cmdDiff(runtime);
      return false;

    case '/reset':
      await cmdReset(runtime);
      return false;

    case '/undo':
      await cmdUndo(runtime);
      return false;

    case '/debug': {
      const mode = arg.trim().toLowerCase();
      if (mode === 'on') setVerbose(true);
      else if (mode === 'off') setVerbose(false);
      else toggleVerbose();
      store.push('info', `Debug mode: ${isVerbose() ? 'on' : 'off'}.`);
      return false;
    }

    case '/verbose':
      store.push('info', `Debug mode: ${toggleVerbose() ? 'on' : 'off'}.`);
      return false;

    case '/logout':
      await cmdLogout();
      runner.refreshInfo();
      return false;

    case '/whoami':
      await cmdWhoami();
      runner.refreshInfo();
      return false;

    case '/exit':
    case '/quit':
      return true;

    default:
      store.push('error', `Unknown command "${cmd}". Type /help for the list.`);
      return false;
  }
}
