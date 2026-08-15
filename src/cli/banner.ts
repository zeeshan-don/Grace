import { DISPLAY_NAME, TAGLINE, VERSION } from '../meta.ts';
import { c } from './colors.ts';
import { boxLines, kv } from './ui/box.ts';
import { symbols, theme } from './ui/theme.ts';

/**
 * Session-start header (GRACE UI).
 *
 * Compact and scannable — a small logo box plus a few label/value rows, then
 * straight to the prompt. No ASCII art, no fake input box:
 *
 *   ╭─────────────────────────────╮
 *   │            GRACE            │
 *   │   AI Coding Agent · v0.1.0  │
 *   ╰─────────────────────────────╯
 *   Directory  D:\Projects\my-app
 *   Provider   NVIDIA NIM
 *   Model      openai/gpt-oss-20b
 *   Session    logged in as user@example.com · 58m remaining
 *   Quota      5 sessions remaining
 *
 *   Type /help for commands.
 *
 * grace>
 */

export interface BannerInfo {
  /** Absolute (or ~-shortened) project directory. */
  directory: string;
  /** Provider label (or a warning when unavailable). */
  provider: string;
  /** Active model id (or '—'). */
  model: string;
  /** Auth/session status. */
  session: string;
  /** GRACE FREE daily session line (optional — hidden when absent). */
  freePlan?: string;
}

export function renderBanner(info: BannerInfo): string {
  const th = theme();
  const rows = [
    kv('Directory', th.path(info.directory)),
    kv('Provider', th.provider(info.provider)),
    kv('Model', th.model(info.model)),
    kv('Session', info.session),
  ];
  if (info.freePlan) rows.push(kv('Quota', info.freePlan));
  return [
    boxLines([
      `  ${c.bold(c.cyan(DISPLAY_NAME))}`,
      `  ${c.dim(`${TAGLINE} · v${VERSION}`)}`,
    ]),
    '',
    ...rows,
    '',
    `  ${c.dim('Type /help for commands.')}`,
  ].join('\n');
}

export function renderHelp(): string {
  const sym = symbols();
  return [
    c.bold('Commands'),
    c.dim('  /help                Show this help'),
    c.dim('  /status              Workspace, git, model and session status'),
    c.dim('  /model               Show current provider & model'),
    c.dim('  /model <id>          Switch model (e.g. /model qwen/qwen3.6-27b)'),
    c.dim('  /model list          List models available on the provider'),
    c.dim('  /provider            Show how the provider is selected'),
    c.dim('  /provider groq       Use a local Groq key for this session'),
    c.dim('  /cd <path>           Change the active workspace'),
    c.dim('  /diff                Show current git changes (or agent-modified files)'),
    c.dim('  /clear               Clear the terminal screen'),
    c.dim('  /reset               Clear the conversation/task context (keeps workspace)'),
    c.dim('  /undo                Revert the last file change made by the agent'),
    c.dim('  /debug               Toggle debug diagnostics (also /verbose)'),
    c.dim('  /login               Log in to the GRACE backend'),
    c.dim('  /logout              Log out and remove the local session'),
    c.dim('  /whoami              Show the authenticated identity'),
    c.dim('  /exit                Quit the session (also /quit, Ctrl+C, Ctrl+D)'),
    '',
    c.bold('Usage'),
    c.dim('  Type a task in plain English and the agent will inspect the repo,'),
    c.dim('  edit files, run tests, fix errors and report what changed.'),
    c.dim('  After a task finishes you return to the prompt — just keep typing.'),
    c.dim('  Multiline tasks: end a line with \\\\ to continue on the next line.'),
    '',
    c.bold('One-shot mode'),
    c.dim('  grace "Fix the login bug"   runs once and exits'),
    c.dim('  grace --yes "…"             auto-approve flagged commands (careful!)'),
    c.dim('  grace --verbose "…"         show raw diagnostics for this run'),
    c.dim('  grace --new-window          start the REPL in a new terminal window'),
    `  ${c.dim(`${sym.bullet} Progress marks: ${sym.check} done · ${sym.cross} failed · ${sym.warn} warning`)}`,
  ].join('\n');
}
