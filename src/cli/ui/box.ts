/**
 * Box/layout helpers (GRACE UI).
 *
 * Small composable pieces — divider, section headers, label/value rows and
 * the prompt box — built on the capability-aware theme so they degrade
 * gracefully on legacy terminals.
 */
import { symbols, theme, type Symbols, type Theme } from './theme.ts';

/** Full-width horizontal divider, e.g. ────────────────. */
export function divider(width = 48): string {
  const sym = symbols();
  return sym.hLine.repeat(Math.max(8, width));
}

/** Section header, e.g. "Files changed". */
export function section(title: string): string {
  return theme().bold(title);
}

/**
 * One aligned label/value row, e.g. "Directory  D:\Projects\app".
 * The default padding keeps values aligned at column 12 (banner); callers with
 * longer labels (e.g. "Working tree") can pass a wider pad.
 */
export function kv(label: string, value: string, pad = 10): string {
  const th = theme();
  return `  ${th.label(label.padEnd(pad))}${value}`;
}

export interface BoxOptions {
  /** Column width of the box. Default: terminal width clamped to [44, 76]. */
  width?: number;
  /** Title printed on the top border, e.g. " grace ". */
  title?: string;
}

/** Clamp a number to [min, max]. */
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Render a single-line box with an optional title in the top border:
 *
 *   ┌─────────── grace ───────────┐
 *   │ Enter a coding task or /…   │
 *   └─────────────────────────────┘
 */
export function box(line: string, opts: BoxOptions = {}): string {
  const sym: Symbols = symbols();
  const th: Theme = theme();
  const width = clamp(opts.width ?? (process.stdout.columns ?? 60), 44, 76);
  const inner = line.length > width - 4 ? `${line.slice(0, width - 7)}${sym.ellipsis}` : line;

  let top: string;
  if (opts.title) {
    const t = ` ${opts.title} `;
    const side = Math.max(0, width - 2 - t.length);
    const left = Math.floor(side / 2);
    const right = side - left;
    top = `${sym.cornerTl}${sym.hLine.repeat(left)}${th.bold(t)}${sym.hLine.repeat(right)}${sym.cornerTr}`;
  } else {
    top = `${sym.cornerTl}${sym.hLine.repeat(width - 2)}${sym.cornerTr}`;
  }
  return [
    top,
    `${sym.vLine} ${inner.padEnd(width - 4)} ${sym.vLine}`,
    `${sym.cornerBl}${sym.hLine.repeat(width - 2)}${sym.cornerBr}`,
  ].join('\n');
}

/**
 * The persistent workspace hint shown at the bottom of the interactive
 * session before the input line (TTY only).
 */
export function promptBox(hint = 'Enter a coding task or / for commands', opts: BoxOptions = {}): string {
  return box(hint, { title: 'grace', ...opts });
}
