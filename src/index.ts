#!/usr/bin/env node
import { cwd } from 'node:process';
import { PRODUCT, TAGLINE, VERSION } from './meta.ts';
import { cmdLogin, cmdLogout, cmdRegister, cmdWhoami } from './cli/authCommands.ts';
import { runOnce } from './cli/once.ts';
import { runRepl } from './cli/repl.ts';
import { launchInNewWindow, newWindowNotice } from './cli/window.ts';

/** Top-level subcommands (auth, Milestone 11). Everything else is a prompt. */
const SUBCOMMANDS = new Set(['login', 'register', 'logout', 'whoami']);

type Subcommand = 'login' | 'register' | 'logout' | 'whoami';

interface ParsedArgs {
  yes: boolean;
  model?: string;
  verbose: boolean;
  newWindow: boolean;
  help: boolean;
  version: boolean;
  subcommand?: Subcommand;
  /** Argument after the subcommand (e.g. email for login/register). */
  subcommandArg?: string;
  prompt?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { yes: false, help: false, version: false, verbose: false, newWindow: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i] as string;
    if (a === '--yes' || a === '-y') {
      out.yes = true;
    } else if (a === '--model') {
      out.model = argv[i + 1];
      i += 1;
    } else if (a === '--verbose' || a === '--debug') {
      out.verbose = true;
    } else if (a === '--new-window') {
      out.newWindow = true;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === '--version' || a === '-v') {
      out.version = true;
    } else if (a === '--') {
      out.prompt = argv.slice(i + 1).join(' ');
      break;
    } else if (!a.startsWith('-')) {
      // First positional: a known subcommand, or a one-shot prompt.
      const rest = argv.slice(i);
      if (SUBCOMMANDS.has(rest[0] as string)) {
        out.subcommand = rest[0] as Subcommand;
        out.subcommandArg = rest.slice(1).join(' ').trim();
      } else {
        out.prompt = rest.join(' ');
      }
      break;
    } else {
      console.error(`Unknown option: ${a}`);
      out.help = true;
    }
    i += 1;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(`${PRODUCT} v${VERSION}`);
    return;
  }
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.newWindow) {
    const launched = await launchInNewWindow(cwd());
    if (launched) {
      console.log(newWindowNotice(cwd()));
    } else {
      console.error('Could not open a new terminal window — starting Grace in this terminal instead.');
      process.exitCode = await runRepl({ yes: args.yes, model: args.model, verbose: args.verbose });
    }
    return;
  }
  if (args.subcommand) {
    process.exitCode = await runSubcommand(args.subcommand, args.subcommandArg ?? '');
    return;
  }
  if (args.prompt) {
    process.exitCode = await runOnce(args.prompt, { yes: args.yes, model: args.model, verbose: args.verbose });
    return;
  }
  process.exitCode = await runRepl({ yes: args.yes, model: args.model, verbose: args.verbose });
  void cwd;
}

async function runSubcommand(cmd: Subcommand, arg: string): Promise<number> {
  switch (cmd) {
    case 'login':
      return cmdLogin(arg);
    case 'register':
      return cmdRegister(arg);
    case 'logout':
      return cmdLogout();
    case 'whoami':
      return cmdWhoami();
  }
}

function usage(): string {
  return [
    `${PRODUCT} v${VERSION} — ${TAGLINE}`,
    '',
    'Usage:',
    '  grace                            Start the interactive REPL',
    '  grace "describe a task"          One-shot run, then exit',
    '  grace login [email]              Log in to the GRACE backend',
    '  grace register [email]           Create an account',
    '  grace logout                     Log out and remove the local session',
    '  grace whoami                     Show the authenticated identity',
    '',
    'Options:',
    '  --model <id>     Override the model (e.g. openai/gpt-oss-20b)',
    '  --yes, -y        Auto-approve flagged commands (dangerous!)',
    '  --new-window     Start Grace in a new terminal window (workspace preserved)',
    '  --verbose        Show verbose diagnostics (raw output, agent details)',
    '  --debug          Alias for --verbose',
    '  --help, -h       Show this help',
    '  --version, -v    Show version',
    '',
    'Interactive commands (inside the REPL):',
    '  /help  /status  /model  /provider  /cd <path>  /diff  /clear  /reset',
    '  /undo  /debug  /login  /logout  /whoami  /exit',
    '',
    'Environment:',
    '  GROQ_API_KEY     Your Groq API key (optional when logged in — the backend provides the model)',
    '  NVIDIA_API_KEY   Server-side only (Vercel env) — never needed on the CLI',
    '  ZEESH_API_URL    GRACE backend URL (default https://zeesh-ai.vercel.app; set to http://localhost:8787 for local dev)',
    '  ZEESH_SHELL      Override the shell used by run_command',
    '  NO_COLOR         Disable ANSI colors',
  ].join('\n');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
