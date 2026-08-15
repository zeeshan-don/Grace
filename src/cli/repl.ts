import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { createInterface as createInterfaceEvents } from 'node:readline';
import { createInterface as createInterfacePromises } from 'node:readline/promises';
import { stdin as processStdin, stdout as processStdout, cwd } from 'node:process';
import { ApiClient, type DailySessionState } from '../auth/client.ts';
import { loadSession } from '../auth/session.ts';
import { loadEnv } from '../config/config.ts';
import { RemoteProvider } from '../providers/remote.ts';
import { createRuntime, type Runtime } from '../runtime.ts';
import { shortPath } from '../util/text.ts';
import { cmdLogin, cmdLogout, cmdRegister, cmdWhoami } from './authCommands.ts';
import { renderBanner } from './banner.ts';
import { c } from './colors.ts';
import { cmdClear, cmdDiff, cmdHelp, cmdModel, cmdProvider, cmdReset, cmdStatus, cmdUndo } from './commands.ts';
import { bannerFreePlanLine, formatCountdown, sessionSecondsLeft } from './freePlan.ts';
import { runTask } from './taskRunner.ts';
import { kv } from './ui/box.ts';
import { theme } from './ui/theme.ts';
import { isVerbose, setVerbose, toggleVerbose } from './verbose.ts';

export interface ReplOptions {
  yes?: boolean;
  model?: string;
  verbose?: boolean;
}

/**
 * The one real interactive prompt. The terminal itself is the UI — there is
 * no fake textbox drawn around it.
 */
const PROMPT = c.bold('grace') + c.cyan('> ');
const CONTINUATION_PROMPT = c.cyan('… ');

/**
 * Mutable REPL state. `/cd` swaps the runtime (new workspace); every task and
 * slash command reads the current one.
 */
interface ReplContext {
  runtime: Runtime;
  /** Build a fresh runtime for a root, reusing the session's permission hook. */
  makeRuntime(root: string): Runtime;
}

/** The in-flight task's abort controller — Ctrl+C cancels it (TTY mode). */
let activeTask: AbortController | null = null;

export async function runRepl(opts: ReplOptions = {}): Promise<number> {
  const root = cwd();
  loadEnv(root);
  if (opts.verbose) setVerbose(true);
  const isTty = Boolean(processStdin.isTTY && processStdout.isTTY);
  if (!isTty) {
    // The full-screen interface needs a real terminal. Say why the classic
    // prompt is used so a launch through a wrapper (npm script, IDE task,
    // shell alias piping stdio, …) is not mistaken for a missing feature.
    const missing = !processStdin.isTTY && !processStdout.isTTY ? 'stdin and stdout' : !processStdin.isTTY ? 'stdin' : 'stdout';
    console.error(
      c.dim(
        `Full-screen interface skipped: ${missing} ${missing === 'stdin and stdout' ? 'are' : 'is'} not attached to a terminal here. ` +
          'Run `grace --new-window` for the full-screen TUI, or launch grace directly in a terminal (Windows Terminal / PowerShell 7+ / VS Code).',
      ),
    );
    return runPiped(root, opts);
  }
  // The full-screen TUI is loaded lazily so piped/CI mode never depends on it.
  try {
    const { runTui } = await import('./tui/index.ts');
    return await runTui(root, opts);
  } catch (err) {
    console.error(
      c.yellow(`Full-screen interface unavailable (${(err as Error).message ?? err}) — using the classic prompt.`),
    );
    return runTty(root, opts);
  }
}

// ---------------------------------------------------------------------------
// TTY mode
// ---------------------------------------------------------------------------

async function runTty(root: string, opts: ReplOptions): Promise<number> {
  const rl = createInterfacePromises({ input: processStdin, output: processStdout, terminal: true });
  const makeRuntime = (r: string): Runtime =>
    createRuntime(r, {
      yes: opts.yes,
      model: opts.model,
      ask: (cmd, reasons) => askPermission(rl, cmd, reasons),
    });
  const ctx: ReplContext = { runtime: makeRuntime(root), makeRuntime };
  await printBanner(ctx.runtime);

  // Ctrl+C while idle at the prompt: close the interface → the pending
  // question rejects → exit cleanly.
  rl.on('SIGINT', () => {
    rl.close();
  });

  // Ctrl+C while a task is running: cancel it safely instead of dying.
  process.on('SIGINT', () => {
    if (activeTask) {
      activeTask.abort();
      processStdout.write('\n' + c.dim('Cancel requested — stopping…') + '\n');
    } else {
      console.log(c.dim('Goodbye.'));
      process.exit(0);
    }
  });

  const finish = () => rl.close();
  await runLoop(ctx, nextTaskTty(rl), finish);
  console.log(c.dim('Goodbye.'));
  return 0;
}

/** Read a single task from TTY with multiline continuation (trailing \). */
function nextTaskTty(
  rl: ReturnType<typeof createInterfacePromises>,
): () => Promise<string | null> {
  return async () => {
    let buffer = '';
    let first = true;
    while (true) {
      let line: string;
      try {
        line = await rl.question(first ? PROMPT : CONTINUATION_PROMPT);
      } catch {
        return null; // EOF / Ctrl+C
      }
      if (buffer === '' && line.trim() === '') continue; // skip blank leading lines
      first = false;
      if (line.trimEnd().endsWith('\\')) {
        buffer += line.trimEnd().slice(0, -1) + '\n';
        continue;
      }
      buffer += line;
      return buffer;
    }
  };
}

// ---------------------------------------------------------------------------
// Piped / non-TTY mode (CI, scripts, tests)
// ---------------------------------------------------------------------------

async function runPiped(root: string, opts: ReplOptions): Promise<number> {
  const makeRuntime = (r: string): Runtime => createRuntime(r, { yes: opts.yes, model: opts.model });
  const ctx: ReplContext = { runtime: makeRuntime(root), makeRuntime };
  await printBanner(ctx.runtime);

  const rl = createInterfaceEvents({ input: processStdin, crlfDelay: Infinity });
  let closed = false;
  const queue: string[] = [];
  let waiters: Array<(line: string | null) => void> = [];

  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const w of waiters.splice(0)) w(null);
  });

  const nextLine = async (): Promise<string | null> => {
    const queued = queue.shift();
    if (queued !== undefined) return queued;
    if (closed) return null;
    return new Promise((resolve) => waiters.push(resolve));
  };

  // Multiline continuation: a line ending with '\' joins to the next line.
  const nextTask = async (): Promise<string | null> => {
    const first = await nextLine();
    if (first === null) return null;
    let buffer = first;
    while (buffer.trimEnd().endsWith('\\')) {
      buffer = buffer.trimEnd().slice(0, -1);
      const more = await nextLine();
      if (more === null) break;
      buffer += '\n' + more;
    }
    return buffer;
  };

  await runLoop(ctx, nextTask, () => {});
  rl.close();
  console.log(c.dim('Goodbye.'));
  return 0;
}

// ---------------------------------------------------------------------------
// Command/agent dispatch loop
// ---------------------------------------------------------------------------

async function runLoop(
  ctx: ReplContext,
  nextTask: () => Promise<string | null>,
  finish: () => void,
): Promise<void> {
  while (true) {
    const task = await nextTask();
    if (task === null) {
      finish();
      return;
    }
    const trimmed = task.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('/')) {
      const [cmd, ...rest] = trimmed.split(/\s+/);
      const arg = rest.join(' ');
      if (!cmd) continue;
      try {
        const shouldExit = await handleSlash(ctx, cmd, arg);
        if (shouldExit) {
          finish();
          return;
        }
      } catch (err) {
        console.log(c.red('Slash command failed unexpectedly: ' + ((err as Error).message ?? err)));
        console.log(c.dim('Returning to the prompt — try again or run /help.'));
      }
      continue;
    }

    // A failing task must never kill the session — report the error and return
    // to the prompt so the user can try another task. Ctrl+C aborts it.
    const controller = new AbortController();
    activeTask = controller;
    try {
      await runTask(ctx.runtime, trimmed, { awaitUsageReport: false, verbose: isVerbose(), signal: controller.signal });
    } catch (err) {
      console.log(c.red('Task failed unexpectedly: ' + ((err as Error).message ?? err)));
      console.log(c.dim('Returning to the prompt — try again or run /help.'));
    } finally {
      activeTask = null;
    }
  }
}

async function handleSlash(ctx: ReplContext, cmd: string, arg: string): Promise<boolean> {
  const { runtime } = ctx;
  switch (cmd) {
    case '/help':
      await cmdHelp();
      break;
    case '/model':
      await cmdModel(runtime, arg);
      break;
    case '/provider':
      await cmdProvider(runtime, arg);
      break;
    case '/status':
      await cmdStatus(runtime);
      break;
    case '/cd': {
      const dir = arg.trim();
      if (!dir) {
        console.log(c.yellow('Usage: /cd <directory>'));
        break;
      }
      const target = resolve(runtime.root, dir);
      let isDir = false;
      try {
        isDir = statSync(target).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        console.log(c.red(`Not a directory: ${target}`));
        break;
      }
      const next = ctx.makeRuntime(target);
      ctx.runtime = next;
      const th = theme();
      console.log(c.green('Workspace changed.'));
      console.log(kv('Workspace', th.path(next.root)));
      console.log(kv('Provider', next.provider ? th.provider(next.provider.label) : c.yellow('not configured')));
      console.log(kv('Model', next.provider ? th.model(next.provider.getModel().id) : th.dim('—')));
      break;
    }
    case '/diff':
      await cmdDiff(runtime);
      break;
    case '/clear':
      await cmdClear();
      break;
    case '/reset':
      await cmdReset(runtime);
      break;
    case '/undo':
      await cmdUndo(runtime);
      break;
    case '/debug': {
      const mode = arg.trim().toLowerCase();
      if (mode === 'on') setVerbose(true);
      else if (mode === 'off') setVerbose(false);
      else toggleVerbose();
      console.log(c.green(`Debug mode: ${isVerbose() ? 'on' : 'off'}.`));
      break;
    }
    case '/verbose':
      console.log(c.green(`Debug mode: ${toggleVerbose() ? 'on' : 'off'}.`));
      break;
    case '/login':
      await cmdLogin(arg);
      break;
    case '/register':
      await cmdRegister(arg);
      break;
    case '/logout':
      await cmdLogout();
      break;
    case '/whoami':
      await cmdWhoami();
      break;
    case '/exit':
    case '/quit':
      return true;
    default:
      console.log(c.yellow(`Unknown command "${cmd}". Type /help for the list.`));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

async function printBanner(runtime: Runtime): Promise<void> {
  const th = theme();
  const session = loadSession();
  const providerStatus = runtime.provider
    ? runtime.provider.label
    : c.yellow('not configured — add GROQ_API_KEY to .env or run /login');
  const modelStatus = runtime.provider ? runtime.provider.getModel().id : th.dim('—');
  const freePlan = await loadBannerFreePlan(runtime);
  const sessionStatus = session
    ? (() => {
        // When a free session is active, the Session row shows the time left
        // (UI only — enforcement stays server-side).
        const left =
          freePlan?.currentSession != null && freePlan.sessionExpiresAt
            ? formatCountdown(sessionSecondsLeft(freePlan.sessionExpiresAt))
            : null;
        return c.green(`logged in as ${session.user.email}${left ? ` · ${left} remaining` : ''}`);
      })()
    : c.dim('not logged in — local-only mode (usage tracking off, optional)');
  console.log(
    renderBanner({
      directory: shortPath(runtime.root, homedir()),
      provider: providerStatus,
      model: modelStatus,
      session: sessionStatus,
      freePlan: freePlan ? bannerFreePlanLine(freePlan) : undefined,
    }),
  );
  console.log('');
}

/**
 * GRACE FREE banner row: fetch the server's daily session state once, briefly.
 * Best-effort only — a slow/unreachable backend never delays or breaks the CLI.
 */
async function loadBannerFreePlan(runtime: Runtime): Promise<DailySessionState | undefined> {
  if (!(runtime.provider instanceof RemoteProvider)) return undefined; // local key / offline
  const session = loadSession();
  if (!session) return undefined;
  try {
    return await new ApiClient(session.apiUrl, 2000).getUsage(session.token);
  } catch {
    return undefined; // backend offline / old backend — banner stays as-is
  }
}

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------

/** Command prefixes the user approved once with "always allow similar". */
const approvedPrefixes = new Set<string>();

/** First word of a command, e.g. "npm" from "npm install jsonwebtoken". */
function commandPrefix(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  return first.replace(/[^a-zA-Z0-9._-]/g, '');
}

async function askPermission(
  rl: ReturnType<typeof createInterfacePromises>,
  command: string,
  reasons: string[],
): Promise<boolean> {
  const prefix = commandPrefix(command);
  if (prefix && approvedPrefixes.has(prefix)) return true;

  const answer = await rl.question(
    `\n${c.red('! Grace wants to run:')}` +
    `\n\n  ${command}` +
    `\n\n${c.yellow(`Flagged: ${reasons.join('; ')}`)}` +
    `\n\n${c.dim('[y] Yes   [n] No   [a] Always allow similar')}` +
    `\n> `,
  );
  const a = answer.trim().toLowerCase();
  if (a.startsWith('a')) {
    if (prefix) approvedPrefixes.add(prefix);
    return true;
  }
  return a.startsWith('y');
}
