import { DISPLAY_NAME, TAGLINE, VERSION } from '../meta.ts';
import { c } from './colors.ts';

const W = 54; // inner box width

function boxLine(inner: string): string {
  return c.cyan('│') + inner.padEnd(W) + c.cyan('│');
}

export function renderBanner(projectLabel: string, providerStatus: string): string {
  const top = c.cyan('╭' + '─'.repeat(W) + '╮');
  const bottom = c.cyan('╰' + '─'.repeat(W) + '╯');
  const lines = [
    top,
    boxLine('  ' + c.bold(DISPLAY_NAME) + '  ' + c.dim(`v${VERSION}`)),
    boxLine('  ' + c.dim(TAGLINE)),
    boxLine(''),
    boxLine('  ' + c.dim('Free AI coding — supported by developer-focused')),
    boxLine('  ' + c.dim('advertising (coming soon)')),
    boxLine(''),
    boxLine('  ' + projectLabel),
    boxLine('  ' + providerStatus),
    bottom,
  ];
  return lines.join('\n');
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
    c.dim('  /exit                Quit (Ctrl+C / Ctrl+D also work)'),
    '',
    c.bold('Usage'),
    c.dim('  Type a task in plain English and the agent will inspect the repo,'),
    c.dim('  edit files, run tests, fix errors and report what changed.'),
    '',
    c.bold('One-shot mode'),
    c.dim('  zeesh "Fix the login bug"   runs once and exits'),
    c.dim('  zeesh --yes "…"             auto-approve flagged commands (careful!)'),
  ].join('\n');
}
