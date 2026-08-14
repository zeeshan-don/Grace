/**
 * Box/layout helpers (GRACE UI).
 *
 * Small composable pieces — divider, section headers, label/value rows and
 * multi-line boxes (used only for the compact startup logo) — built on the
 * capability-aware theme so they degrade gracefully on legacy terminals.
 *
 * There is deliberately NO input box: the terminal prompt itself is the
 * input surface (`grace>`), so nothing in the UI draws a fake textbox.
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
 * Render a single-line box:
 *
 *   ┌─────────────────────────────┐
 *   │ some content                │
 *   └─────────────────────────────┘
 */
export function box(line: string, opts: BoxOptions = {}): string {
  return boxLines([line], opts);
}

/**
 * Render a multi-line box with every line centered:
 *
 *   ┌─────────────────────────────┐
 *   │            GRACE            │
 *   │  AI Coding Agent · v0.1.0   │
 *   └─────────────────────────────┘
 */
export function boxLines(lines: string[], opts: BoxOptions = {}): string {
  const sym: Symbols = symbols();
  const width = clamp(opts.width ?? 44, 30, 76);
  const inner = width - 4; // space + content + space inside the border
  const rows = lines.map((line) => {
    const visible = line.length > inner ? `${line.slice(0, inner - 1)}${sym.ellipsis}` : line;
    return `${sym.vLine} ${visible.padStart(Math.floor((inner + visible.length) / 2)).padEnd(inner)} ${sym.vLine}`;
  });
  return [
    `${sym.cornerTl}${sym.hLine.repeat(width - 2)}${sym.cornerTr}`,
    ...rows,
    `${sym.cornerBl}${sym.hLine.repeat(width - 2)}${sym.cornerBr}`,
  ].join('\n');
}
