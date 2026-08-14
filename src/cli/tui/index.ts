/**
 * GRACE TUI entry (full-screen interface).
 *
 * `grace` on a TTY enters here: the terminal switches to the alternate screen
 * buffer, a real interactive app renders (Ink), and on exit the previous
 * terminal content is restored. console.* is redirected into the activity
 * feed while the TUI runs (existing command output becomes scrollable
 * history); everything is restored on teardown.
 */
import { format } from 'node:util';
import { render } from 'ink';
import { createElement as h } from 'react';
import { loadEnv } from '../../config/config.ts';
import { VERSION } from '../../meta.ts';
import { createRuntime } from '../../runtime.ts';
import { setVerbose } from '../verbose.ts';
import { GraceApp } from './app.ts';
import { TuiRunner } from './runner.ts';
import { TuiStore } from './store.ts';
import { buildTuiInfo, refreshFreePlan } from './info.ts';

export interface TuiOptions {
  yes?: boolean;
  model?: string;
  verbose?: boolean;
}

/**
 * Launch the full-screen GRACE interface. Resolves when the user exits;
 * the caller sets the process exit code.
 */
export async function runTui(root: string, opts: TuiOptions = {}): Promise<number> {
  loadEnv(root);
  if (opts.verbose) setVerbose(true);

  const store = new TuiStore({
    version: VERSION,
    workspace: root,
    provider: '',
    providerAvailable: false,
    model: '',
    session: 'Local mode',
  });

  let runtime = createRuntime(root, {
    yes: opts.yes,
    model: opts.model,
    ask: (cmd, reasons) => store.askPermission(cmd, reasons),
  });

  // Real status snapshot: provider/model from the runtime, session from the
  // stored auth, free-plan quota from the backend (best-effort).
  store.info = buildTuiInfo(runtime);
  void refreshFreePlan(runtime).then((line) => {
    store.info = { ...store.info, freePlan: line };
    store.notify();
  });

  const makeRuntime = (r: string): ReturnType<typeof createRuntime> =>
    createRuntime(r, {
      yes: opts.yes,
      model: opts.model,
      ask: (cmd, reasons) => store.askPermission(cmd, reasons),
    });

  let appInstance: ReturnType<typeof render> | null = null;
  let exitRequested = false;
  const requestExit = (): void => {
    if (exitRequested) return;
    exitRequested = true;
    if (appInstance) appInstance.unmount();
  };

  const runner = new TuiRunner({
    runtime,
    store,
    makeRuntime,
    onExit: requestExit,
  });

  // Redirect console output into the activity feed while the TUI owns the
  // screen (slash commands, auth output, agent notes). Restored on teardown.
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
  };
  const toActivity = (kind: 'console' | 'error'): ((...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      store.push(kind === 'error' ? 'error' : 'console', format(...args));
    };
  console.log = toActivity('console');
  console.error = toActivity('error');
  console.warn = toActivity('console');

  // Ctrl+C outside raw mode (e.g. during startup) must behave the same as
  // inside the app: cancel a running task, otherwise exit cleanly.
  const onSigint = (): void => {
    if (runner.isBusy()) runner.cancelTask();
    else requestExit();
  };
  process.on('SIGINT', onSigint);

  try {
    appInstance = render(
      h(GraceApp, { store, runner, onExit: requestExit }),
      {
        alternateScreen: true,
        exitOnCtrlC: false,
        patchConsole: false,
        incrementalRendering: true,
      },
    );
    await appInstance.waitUntilExit();
  } finally {
    process.removeListener('SIGINT', onSigint);
    // Restore the real console AFTER the alternate screen is left.
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
    try {
      appInstance?.cleanup();
    } catch {
      // best-effort
    }
  }
  return 0;
}
