/**
 * GRACE wordmark (TUI home screen).
 *
 * The hero logo is the exact block letters from GRACE_logo.txt — never
 * redrawn or "improved". The file's uniform indentation is removed and each
 * row is kept exactly as drawn.
 *
 * Why rendering needs special care: the rows have different real widths
 * (the █ block is two cells wide, the box-drawing corners are one), while
 * Ink measures every glyph as one cell. So the rows must be rendered
 * LEFT-ALIGNED inside a box sized by the logo's real width (logoWidth()) —
 * that way the terminal centers the whole piece once, and no individual row
 * gets shifted ("bent"). See HomeScreen in components.ts.
 *
 * Variants:
 *  - logoLines()     the six-row GRACE logo (Unicode, or a 1:1 '#' mirror
 *                    on legacy terminals)
 *  - logoWidth()     real display width of the widest row (centering budget)
 *  - chooseLogoFor() rows + width for the best logo that fits the terminal
 *  - compactLines()  letter-spaced "GRACE" for tiny terminals
 *  - wordmark()      one-line "GRACE" (headers)
 */
import { supportsUnicode } from '../ui/theme.ts';

/** The GRACE logo exactly as drawn in GRACE_logo.txt (common indent removed). */
const LOGO_ROWS = [
  '██████╗ ██████╗  █████╗  ██████╗███████╗',
  '██╔════╝ ██╔══██╗██╔══██╗██╔════╝██╔════╝',
  '██║  ███╗██████╔╝███████║██║     █████╗',
  '██║   ██║██╔══██╗██╔══██║██║     ██╔══╝',
  '╚██████╔╝██║  ██║██║  ██║╚██████╗███████╗',
  ' ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚══════╝',
];

/** Legacy fallback: the same letterforms, every glyph replaced 1:1 with '#'. */
const LOGO_ROWS_ASCII = LOGO_ROWS.map((row) =>
  [...row].map((ch) => (ch === ' ' ? ' ' : '#')).join(''),
);

/**
 * Real terminal width of a logo row: the █ block is two cells, the
 * box-drawing corners and spaces are one. (Ink counts every glyph as one
 * cell, so this is the width the terminal actually displays.)
 */
function cellWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += ch === '█' ? 2 : 1;
  return w;
}

/** The six-row hero logo for this terminal (Unicode or ASCII mirror). */
export function logoLines(): string[] {
  return supportsUnicode() ? [...LOGO_ROWS] : [...LOGO_ROWS_ASCII];
}

/** Real display width of the widest logo row — the centering budget. */
export function logoWidth(): number {
  const rows = logoLines();
  return Math.max(...rows.map(cellWidth));
}

/** Medium/short terminals: an elegant letter-spaced wordmark. */
const COMPACT = ['G   R   A   C   E'];

/** Compact letter-spaced wordmark for narrow or short terminals. */
export function compactLines(): string[] {
  return [...COMPACT];
}

/**
 * The best logo for a terminal: the full six-row logo when it fits (real
 * width + a small margin, and enough rows), otherwise the compact wordmark.
 */
export function chooseLogoFor(columns: number, rows: number): { lines: string[]; width: number } {
  const full = logoLines();
  const fullWidth = logoWidth();
  if (rows >= 13 && columns >= fullWidth + 2) {
    return { lines: full, width: fullWidth };
  }
  const compact = compactLines();
  return { lines: compact, width: Math.max(...compact.map((l) => l.length)) };
}

/** A one-line compact wordmark (status header, session header). */
export function wordmark(): string {
  return 'GRACE';
}
