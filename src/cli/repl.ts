import { homedir } from 'node:os';
import { createInterface as createInterfaceEvents } from 'node:readline';
import { createInterface as createInterfacePromises } from 'node:readline/promises';
import { stdin as processStdin, stdout as processStdout, cwd } from 'node:process';
import { ApiClient } from '../auth/client.ts';
import { loadSession } from '../auth/session.ts';
import { loadEnv } from '../config/config.ts';
import { RemoteProvider } from '../providers/remote.ts';
import { createRuntime, type Runtime } from '../runtime.ts';
import { shortPath } from '../util/text.ts';
import { cmdLogin, cmdLogout, cmdRegister, cmdWhoami } from './authCommands.ts';
import { renderBanner } from './banner.ts';
import { c } from './colors.ts';
import { cmdClear, cmdDiff, cmdHelp, cmdModel, cmdStatus, cmdUndo } from './commands.ts';
import { bannerFreePlanLine } from './freePlan.ts';
import { runTask } from './taskRunner.ts';
import { promptBox } from './ui/box.ts';
import { theme } from './ui/theme.ts';
import { isVerbose, setVerbose, toggleVerbose } from './verbose.ts';

export interface ReplOptions {
  yes?: boolean;
  model?: string;
  verbose?: boolean;
}

/** Interactive prompt (TTY) — branded, clean. */
const PROMPT = c.bold('grace') + c.cyan('› ');
const CONTINUATION_PROMPT = c.cyan('… ');

export async function runRepl(opts: ReplOptions = {}): Promise<number> {
  const root = cwd();
  loadEnv(root);
  if (opts.verbose) setVerbose(true);
  const isTty = Boolean(processStdin.isTTY && processStdout.isTTY);
  if (isTty) return runTty(root, opts);
  return runPiped(root, opts);
}

// ---------------------------------------------------------------------------
// TTY mode
// ---------------------------------------------------------------------------

async function runTty(root: string, opts: ReplOptions): Promise<number> {
  const rl = createInterfacePromises({ input: processStdin, output: processStdout, terminal: true });
  const runtime = createRuntime(root, {
    yes: opts.yes,
    model: opts.model,
    ask: (cmd, reasons) => askPermission(rl, cmd, reasons),
  });
  await printBanner(runtime);
  console.log(promptBox());

  // Ctrl+C at the prompt: close the interface → pending question rejects → exit cleanly.
  rl.on('SIGINT', () => {
    rl.close();
  });

  const finish = () => rl.close();
  await runLoop(runtime, nextTaskTty(rl), finish, () => console.log(promptBox()));
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
  const runtime = createRuntime(root, { yes: opts.yes, model: opts.model });
  await printBanner(runtime);

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

  await runLoop(runtime, nextTask, () => {});
  rl.close();
  console.log(c.dim('Goodbye.'));
  return 0;
}

// ---------------------------------------------------------------------------
// Command/agent dispatch loop
// ---------------------------------------------------------------------------

async function runLoop(
  runtime: Runtime,
  nextTask: () => Promise<string | null>,
  finish: () => void,
  afterTask?: () => void,
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
        const shouldExit = await handleSlash(runtime, cmd, arg);
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
    // to the prompt so the user can try another task.
    try {
      await runTask(runtime, trimmed, { awaitUsageReport: false, verbose: isVerbose() });
    } catch (err) {
      console.log(c.red('Task failed unexpectedly: ' + ((err as Error).message ?? err)));
      console.log(c.dim('Returning to the prompt — try again or run /help.'));
    }
    afterTask?.();
  }
}

async function handleSlash(runtime: Runtime, cmd: string, arg: string): Promise<boolean> {
  switch (cmd) {
    case '/help':
      await cmdHelp();
      break;
    case '/model':
      await cmdModel(runtime, arg);
      break;
    case '/status':
      await cmdStatus(runtime);
      break;
    case '/diff':
      await cmdDiff(runtime);
      break;
    case '/clear':
      await cmdClear(runtime);
      break;
    case '/undo':
      await cmdUndo(runtime);
      break;
    case '/verbose':
      console.log(c.green(`Verbose mode: ${toggleVerbose() ? 'on' : 'off'}.`));
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
  const sessionStatus = session
    ? c.green(`logged in as ${session.user.email} · ${session.apiUrl}`)
    : c.dim('not logged in — local-only mode (usage tracking off, optional)');
  const freePlan = await loadBannerFreePlan(runtime);
  console.log(
    renderBanner({
      directory: shortPath(runtime.root, homedir()),
      provider: providerStatus,
      model: modelStatus,
      session: sessionStatus,
      freePlan,
    }),
  );
  console.log('');
}

/**
 * GRACE FREE banner row: fetch the server's daily session state once, briefly.
 * Best-effort only — a slow/unreachable backend never delays or breaks the CLI.
 */
async function loadBannerFreePlan(runtime: Runtime): Promise<string | undefined> {
  if (!(runtime.provider instanceof RemoteProvider)) return undefined; // local key / offline
  const session = loadSession();
  if (!session) return undefined;
  try {
    const state = await new ApiClient(session.apiUrl, 2000).getUsage(session.token);
    return bannerFreePlanLine(state);
  } catch {
    return undefined; // backend offline / old backend — banner stays as-is
  }
}

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------

async function askPermission(
  rl: ReturnType<typeof createInterfacePromises>,
  command: string,
  reasons: string[],
): Promise<boolean> {
  const answer = await rl.question(
    `\n${c.red('! The agent wants to run:')}` +
    `\n\n  ${command}` +
    `\n\n${c.yellow(`Flagged: ${reasons.join('; ')}`)}` +
    `\n\nAllow? [y/N] `,
  );
  return /^y(es)?$/i.test(answer.trim());
}
