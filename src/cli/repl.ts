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
import { shortPath } from '../util/text.ts';
import { cmdLogin, cmdLogout, cmdRegister, cmdWhoami } from './authCommands.ts';
import { renderBanner } from './banner.ts';
import { c } from './colors.ts';
import { cmdClear, cmdDiff, cmdHelp, cmdModel, cmdStatus, cmdUndo } from './commands.ts';

export interface ReplOptions {
  yes?: boolean;
  model?: string;
}

export async function runRepl(opts: ReplOptions = {}): Promise<number> {
  const root = cwd();
  loadEnv(root);
  const isTty = Boolean(processStdin.isTTY && processStdout.isTTY);

  if (isTty) {
    return runTty(root, opts);
  }
  return runPiped(root, opts);
}

/** Interactive TTY mode: rich prompt, history, live permission questions. */
async function runTty(root: string, opts: ReplOptions): Promise<number> {
  const rl = createInterfacePromises({ input: processStdin, output: processStdout, terminal: true });
  const runtime = createRuntime(root, {
    yes: opts.yes,
    model: opts.model,
    ask: (cmd, reasons) => askPermission(rl, cmd, reasons),
  });
  printBanner(runtime);

  const finish = () => rl.close();
  await runLoop(runtime, async () => {
    try {
      return await rl.question(c.green('> '));
    } catch {
      return null; // EOF / Ctrl+C
    }
  }, finish);
  console.log(c.dim('Goodbye.'));
  return 0;
}

/** Non-TTY / piped mode: process stdin lines (CI, scripts, tests). */
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

  await runLoop(runtime, nextLine, () => {});
  rl.close();
  console.log(c.dim('Goodbye.'));
  return 0;
}

/** Shared command/agent dispatch loop. */
async function runLoop(
  runtime: Runtime,
  nextLine: () => Promise<string | null>,
  finish: () => void,
): Promise<void> {
  while (true) {
    const line = await nextLine();
    if (line === null) {
      finish();
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('/')) {
      const [cmd, ...rest] = trimmed.split(/\s+/);
      const arg = rest.join(' ');
      if (!cmd) continue;
      const shouldExit = await handleSlash(runtime, cmd, arg);
      if (shouldExit) {
        finish();
        return;
      }
      continue;
    }

    await runAgent(runtime, trimmed);
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

function printBanner(runtime: Runtime): void {
  const projectLabelText = `${projectLabel(runtime.project)} · ${shortPath(runtime.root, homedir())}`;
  const providerStatus = runtime.provider
    ? `${runtime.provider.label} · ${runtime.provider.getModel().id}`
    : c.yellow('No provider — add GROQ_API_KEY to .env or /login to use the ZEESH AI backend');
  console.log(renderBanner(projectLabelText, providerStatus));
  console.log(c.dim('Type /help for commands, or describe a task in plain English.'));
  if (!loadSession()) {
    console.log(
      c.dim('Not logged in — usage tracking is off. Login is optional: local/offline use works without it.'),
    );
  }
  console.log('');
}

export async function runAgent(runtime: Runtime, input: string): Promise<void> {
  if (!runtime.provider) {
    console.log(c.red(runtime.providerError ?? 'No AI provider configured.'));
    return;
  }
  const onStatus = (msg: string) => console.log(c.gray('· ' + msg));

  const loop = new AgentLoop({
    provider: runtime.provider,
    tools: runtime.tools,
    projectRoot: runtime.root,
    project: runtime.project,
    session: runtime.session,
    undo: runtime.undo,
    onStatus,
    onStream: (text) => processStdout.write(text),
    askPermission: runtime.ask,
  });

  console.log('');
  const startedAt = Date.now();
  const result = await loop.run(input);
  const executionTimeMs = Date.now() - startedAt;
  console.log('');
  printSummary(result);

  // Milestone 11-12: report usage to the backend when logged in. Never blocks
  // or breaks the session — offline/local-only use stays fully functional; a
  // backend outage is reported as a non-fatal dim note.
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

function printSummary(result: Awaited<ReturnType<AgentLoop['run']>>): void {
  const lines: string[] = [];
  if (result.changedFiles.length > 0) {
    lines.push(c.bold('Changed files:') + ' ' + result.changedFiles.join(', '));
  }
  lines.push(c.dim(`${result.iterations} iteration(s) · ${result.toolCalls} tool call(s)`));
  if (result.usage) {
    lines.push(c.dim(`tokens: ${result.usage.inputTokens} in · ${result.usage.outputTokens} out`));
  }
  if (result.reachedLimit) {
    lines.push(c.yellow('Iteration limit reached — send "continue" to keep going.'));
  }
  console.log(lines.join('\n'));
}

async function askPermission(rl: ReturnType<typeof createInterfacePromises>, command: string, reasons: string[]): Promise<boolean> {
  const answer = await rl.question(
    `\n${c.red('The agent wants to run:')}\n\n  ${command}\n\n${c.yellow(`Flagged: ${reasons.join('; ')}`)}\n\nAllow? [y/N] `,
  );
  return /^y(es)?$/i.test(answer.trim());
}
