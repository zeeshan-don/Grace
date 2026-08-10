import { homedir } from 'node:os';
import { createInterface as createInterfaceEvents } from 'node:readline';
import { createInterface as createInterfacePromises } from 'node:readline/promises';
import { stdin as processStdin, stdout as processStdout, cwd } from 'node:process';
import { AgentLoop } from '../agent/loop.ts';
import { reportRunUsage } from '../auth/reporting.ts';
import { loadSession } from '../auth/session.ts';
import { loadEnv } from '../config/config.ts';
import { projectLabel } from '../project/detect.ts';
import { createRuntime, type Runtime } from '../runtime.ts';
import { formatDuration, shortPath } from '../util/text.ts';
import { cmdLogin, cmdLogout, cmdRegister, cmdWhoami } from './authCommands.ts';
import { renderBanner } from './banner.ts';
import { c } from './colors.ts';
import { cmdClear, cmdDiff, cmdHelp, cmdModel, cmdStatus, cmdUndo } from './commands.ts';

export interface ReplOptions {
  yes?: boolean;
  model?: string;
}

/** Interactive prompt (TTY) — branded, clean. */
const PROMPT = c.bold('zeesh') + c.cyan('› ');
const CONTINUATION_PROMPT = c.cyan('… ');

export async function runRepl(opts: ReplOptions = {}): Promise<number> {
  const root = cwd();
  loadEnv(root);
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
  printBanner(runtime);

  // Ctrl+C at the prompt: close the interface → pending question rejects → exit cleanly.
  rl.on('SIGINT', () => {
    rl.close();
  });

  const finish = () => rl.close();
  await runLoop(runtime, nextTaskTty(rl), finish);
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
  printBanner(runtime);

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
      await runAgent(runtime, trimmed);
    } catch (err) {
      console.log(c.red('Task failed unexpectedly: ' + ((err as Error).message ?? err)));
      console.log(c.dim('Returning to the prompt — try again or run /help.'));
    }
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

function printBanner(runtime: Runtime): void {
  const projectLabelText = `${projectLabel(runtime.project)} · ${shortPath(runtime.root, homedir())}`;
  const providerStatus = runtime.provider
    ? `${runtime.provider.label} · ${runtime.provider.getModel().id}`
    : c.yellow('not configured — add GROQ_API_KEY to .env or run /login');
  const session = loadSession();
  const sessionStatus = session
    ? c.green(`logged in as ${session.user.email} · ${session.apiUrl}`)
    : c.dim('not logged in — local-only mode (usage tracking off, optional)');
  console.log(renderBanner({ project: projectLabelText, provider: providerStatus, session: sessionStatus }));
  console.log('');
}

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------

export async function runAgent(runtime: Runtime, input: string): Promise<void> {
  if (!runtime.provider) {
    console.log(c.red(runtime.providerError ?? 'No AI provider configured.'));
    return;
  }

  let streamed = '';
  const onStatus = (msg: string) => {
    // The loop emits its own "Done in …" status; the CLI prints its own richer
    // summary, so we skip that line to avoid duplication.
    if (/^Done in /.test(msg)) return;
    console.log(c.gray('· ' + msg));
  };

  const loop = new AgentLoop({
    provider: runtime.provider,
    tools: runtime.tools,
    projectRoot: runtime.root,
    project: runtime.project,
    session: runtime.session,
    undo: runtime.undo,
    onStatus,
    onStream: (text) => {
      streamed += text;
      processStdout.write(text);
    },
    askPermission: runtime.ask,
  });

  console.log('');
  const startedAt = Date.now();
  const result = await loop.run(input);
  const executionTimeMs = Date.now() - startedAt;
  console.log('');

  // When nothing was streamed (e.g. a provider error), print the final text so
  // the user sees what went wrong.  Skip when the iteration limit was hit
  // without content — the summary already shows a yellow hint for that case.
  if (result.finalText && !streamed && !result.reachedLimit) {
    console.log(c.red(result.finalText));
    console.log('');
  }

  printSummary(result, executionTimeMs);

  // Usage reporting: fire-and-forget; never blocks the session.
  if (runtime.provider) {
    void reportRunUsage({
      prompt: input,
      model: runtime.provider.getModel().id,
      projectType: runtime.project.type,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      usage: result.usage,
      executionTimeMs,
    }).then((outcome) => {
      if (outcome === 'failed') {
        console.log(c.dim('· usage report failed (backend offline) — run continued locally.'));
      }
    });
  }
}

function printSummary(
  result: Awaited<ReturnType<AgentLoop['run']>>,
  executionTimeMs: number,
): void {
  const lines: string[] = [];
  if (result.changedFiles.length > 0) {
    lines.push(c.bold('Changed files:') + ' ' + result.changedFiles.join(', '));
  }
  lines.push(
    c.dim(
      `${result.iterations} iteration(s) · ${result.toolCalls} tool call(s) · ${formatDuration(executionTimeMs)}`,
    ),
  );
  if (result.usage) {
    lines.push(c.dim(`tokens: ${result.usage.inputTokens} in · ${result.usage.outputTokens} out`));
  }
  if (result.reachedLimit) {
    lines.push(c.yellow('Iteration limit reached — send "continue" to keep going.'));
  }
  console.log(lines.join('\n'));
}

async function askPermission(
  rl: ReturnType<typeof createInterfacePromises>,
  command: string,
  reasons: string[],
): Promise<boolean> {
  const answer = await rl.question(
    `\n${c.red('The agent wants to run:')}\n\n  ${command}\n\n${c.yellow(`Flagged: ${reasons.join('; ')}`)}\n\nAllow? [y/N] `,
  );
  return /^y(es)?$/i.test(answer.trim());
}