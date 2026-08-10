import { DISPLAY_NAME, TAGLINE, VERSION } from '../meta.ts';
import { c } from './colors.ts';
import { divider, kv } from './ui/box.ts';
import { symbols, theme } from './ui/theme.ts';

/**
 * Session-start header (GRACE UI).
 *
 * Compact and scannable — no ASCII art:
 *
 *   GRACE
 *   GRACE · AI Coding Agent · v0.1.0
 *   ────────────────────────────────
 *   Directory  D:\Projects\my-app
 *   Provider   NVIDIA NIM
 *   Model      qwen/qwen2.5-coder-32b-instruct
 *   Session    logged in as user@example.com
 *   ────────────────────────────────
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
  const sym = symbols();
  const th = theme();
  const rows = [
    kv('Directory', th.path(info.directory)),
    kv('Provider', th.provider(info.provider)),
    kv('Model', th.model(info.model)),
    kv('Session', info.session),
  ];
  if (info.freePlan) rows.push(kv('Free plan', info.freePlan));
  return [
    `  ${c.bold(c.cyan('GRACE'))}`,
    `  ${c.dim(`${DISPLAY_NAME} · ${TAGLINE} · v${VERSION}`)}`,
    `  ${c.dim(divider())}`,
    ...rows,
    `  ${c.dim(divider())}`,
    `  ${c.dim(`Enter a coding task or / for commands`)}`,
  ].join('\n');
}

export function renderHelp(): string {
  const sym = symbols();
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
    c.dim('  /verbose             Toggle verbose diagnostics (raw output, details)'),
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
    `  ${c.dim(`${sym.bullet} Progress marks: ${sym.check} done · ${sym.cross} failed · ${sym.warn} warning`)}`,
  ].join('\n');
}
