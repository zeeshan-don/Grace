/**
 * Terminal capability detection + semantic styling (GRACE UI layer).
 *
 * Everything here reads the environment at CALL time (never at module load)
 * so the render helpers can be unit-tested in any terminal state. Two
 * capabilities drive all rendering:
 *
 *  - ANSI color: reuse `c` from src/cli/colors.ts (auto-disabled for
 *    non-TTY / NO_COLOR / TERM=dumb).
 *  - Unicode glyphs: box-drawing, check marks, arrows and braille spinners
 *    degrade to ASCII on legacy terminals (Windows conhost without a modern
 *    terminal marker). Override with ZEESH_UNICODE=1 / ZEESH_ASCII=1.
 *
 * The semantic theme (`theme()`) maps roles → styles so callers never
 * hard-code escape codes or glyphs anywhere in the CLI.
 */
import { c } from '../colors.ts';

export type Platform = NodeJS.Platform;

/** True when ANSI color sequences are safe (TTY + not disabled). */
export function supportsAnsi(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
}

/**
 * True when the terminal renders Unicode glyphs reliably.
 *
 * - Explicit overrides win: ZEESH_UNICODE=1 forces on, ZEESH_ASCII=1 forces off.
 * - Modern terminals announce themselves (Windows Terminal, VS Code, Hyper,
 *   ConEmu, ANSICON) → Unicode.
 * - Anything else on Windows (legacy conhost/PowerShell) → ASCII fallback.
 * - Unix terminals → Unicode.
 */
export function supportsUnicode(platform: Platform = process.platform): boolean {
  if (process.env.ZEESH_UNICODE === '1') return true;
  if (process.env.ZEESH_ASCII === '1') return false;
  if (
    process.env.WT_SESSION ||
    process.env.TERM_PROGRAM ||
    process.env.ConEmuANSI ||
    process.env.ANSICON
  ) {
    return true;
  }
  return platform !== 'win32';
}

/** Every glyph the UI uses, with a safe ASCII equivalent. */
export interface Symbols {
  check: string;
  cross: string;
  warn: string;
  /** Small pending/working bullet ("· Grace is working…"). */
  bullet: string;
  /** Settled progress bullet ("• Exploring the project"). */
  dot: string;
  arrow: string;
  ellipsis: string;
  cornerTl: string;
  cornerTr: string;
  cornerBl: string;
  cornerBr: string;
  hLine: string;
  vLine: string;
  mid: string;
  /** Rotating spinner frames (subtle, for live progress only). */
  spinner: readonly string[];
}

/** Current symbol set for the active terminal (see supportsUnicode). */
export function symbols(platform: Platform = process.platform): Symbols {
  if (supportsUnicode(platform)) {
    return {
      check: '✓',
      cross: '✗',
      warn: '!',
      bullet: '·',
      dot: '•',
      arrow: '→',
      ellipsis: '…',
      cornerTl: '┌',
      cornerTr: '┐',
      cornerBl: '└',
      cornerBr: '┘',
      hLine: '─',
      vLine: '│',
      mid: '├',
      spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    };
  }
  return {
    check: '[ok]',
    cross: '[x]',
    warn: '[!]',
    bullet: '-',
    dot: '*',
    arrow: '->',
    ellipsis: '...',
    cornerTl: '+',
    cornerTr: '+',
    cornerBl: '+',
    cornerBr: '+',
    hLine: '-',
    vLine: '|',
    mid: '+',
    spinner: ['|', '/', '-', '\\'],
  };
}

/** Semantic styles — callers use these, never raw ANSI. */
export interface Theme {
  success: (text: string) => string;
  error: (text: string) => string;
  warn: (text: string) => string;
  info: (text: string) => string;
  dim: (text: string) => string;
  bold: (text: string) => string;
  /** Field labels (dim, secondary). */
  label: (text: string) => string;
  /** Agent names. */
  agent: (text: string) => string;
  /** Provider names. */
  provider: (text: string) => string;
  /** Model names. */
  model: (text: string) => string;
  /** Shell commands / CLI commands. */
  command: (text: string) => string;
  /** File paths. */
  path: (text: string) => string;
  /** Numbers / durations. */
  number: (text: string) => string;
}

/** Semantic theme bound to the current terminal (no-ops when color is off). */
export function theme(): Theme {
  return {
    success: c.green,
    error: c.red,
    warn: c.yellow,
    info: c.cyan,
    dim: c.dim,
    bold: c.bold,
    label: c.dim,
    agent: c.yellow,
    provider: c.cyan,
    model: c.magenta,
    command: c.cyan,
    path: c.blue,
    number: c.yellow,
  };
}

/** Strip ANSI escape sequences (used for width math and test assertions). */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Visible width of a string on the terminal (approximate, code-point based). */
export function visualWidth(text: string): number {
  return [...stripAnsi(text)].length;
}
