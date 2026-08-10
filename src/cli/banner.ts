import { DISPLAY_NAME, TAGLINE, VERSION } from '../meta.ts';
import { c } from './colors.ts';

/**
 * Original ZEESH AI wordmark (hand-rendered block letters). Deliberately our
 * own branding — no third-party ASCII art.
 */
const ART = [
  '███████╗███████╗███████╗███████╗██╗  ██╗',
  '╚══███╔╝██╔════╝██╔════╝██╔════╝██║  ██║',
  '  ███╔╝ █████╗  █████╗  ███████╗███████║',
  ' ███╔╝  ██╔══╝  ██╔══╝  ╚════██║██╔══██║',
  '███████╗███████╗███████╗███████║██║  ██║',
  '╚══════╝╚══════╝╚══════╝╚══════╝╚═╝  ╚═╝',
] as const;

export interface BannerInfo {
  /** Project type + path, e.g. "node · ~/dev/app". */
  project: string;
  /** Provider + model, or a warning when unavailable. */
  provider: string;
  /** Auth/session status, e.g. "logged in as dev@example.com". */
  session: string;
}

const W = 64; // status panel width

function divider(): string {
  return '─'.repeat(W);
}

function row(label: string, value: string): string {
  return `  ${c.dim(label.padEnd(10))}${value}`;
}

export function renderBanner(info: BannerInfo): string {
  const art = ART.map((line) => '  ' + c.cyan(line)).join('\n');
  const head = `  ${c.bold(c.cyan(DISPLAY_NAME))} · ${c.dim(TAGLINE)} · ${c.dim(`v${VERSION}`)}`;
  return [
    art,
    head,
    `  ${c.dim(divider())}`,
    row('Directory', info.project),
    row('Provider', info.provider),
    row('Session', info.session),
    `  ${c.dim(divider())}`,
    `  ${c.dim('Enter a coding task or / for commands')}  ${c.dim('(e.g. /help · /exit)')}`,
  ].join('\n');
}

export function renderHelp(): string {
  return [
    c.bold('Commands'),
    c.dim('  /help                Show this help'),
    c.dim('  /model               Show current provider & model'),
    c.dim('  /model <id>          Switch model (e.g. /model qwen/qwen3.6-27b)'),
    c.dim('  /model list          List models available on the provider'),
    c.dim('  /status              Project, git, model and session status'),
    c.dim('  /diff                Show current git changes (or agent-modified files)'),
    c.dim('  /clear               Wipe conversation history'),
    c.dim('  /undo                Revert the last file change made by the agent'),
    c.dim('  /login               Log in to the ZEESH AI backend'),
    c.dim('  /logout              Log out and remove the local session'),
    c.dim('  /whoami              Show the authenticated identity'),
    c.dim('  /exit                Quit the session (also /quit, Ctrl+C, Ctrl+D)'),
    '',
    c.bold('Usage'),
    c.dim('  Type a task in plain English and the agent will inspect the repo,'),
    c.dim('  edit files, run tests, fix errors and report what changed.'),
    c.dim('  After a task finishes you return to the prompt — just keep typing.'),
    c.dim('  Multiline tasks: end a line with \\ to continue on the next line.'),
    '',
    c.bold('One-shot mode'),
    c.dim('  zeesh "Fix the login bug"   runs once and exits'),
    c.dim('  zeesh --yes "…"             auto-approve flagged commands (careful!)'),
  ].join('\n');
}
