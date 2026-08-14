/**
 * GRACE wordmark (TUI home screen).
 *
 * An original block-letter rendering of the GRACE name — no copied artwork.
 * Two variants: a Unicode block-font version for modern terminals and a pure
 * ASCII version for legacy consoles (see supportsUnicode). Text is plain
 * (ANSI-free); the renderer colors it.
 */
import { supportsUnicode } from '../ui/theme.ts';

const UNICODE_LOGO = [
  '  ██████╗  ██████╗  █████╗  ██████╗ ███████╗',
  '  ██╔════╝ ██╔══██╗██╔══██╗██╔════╝ ██╔════╝',
  '  ██║  ███╗██████╔╝███████║██║  ███╗█████╗  ',
  '  ██║   ██║██╔══██╗██╔══██║██║   ██║██╔══╝  ',
  '  ╚██████╔╝██║  ██║██║  ██║╚██████╔╝███████╗',
  '   ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝',
];

const ASCII_LOGO = [
  '  #####   #####    ####   ######  #######',
  '  ##      ##  ##  ##  ##  ##      ##     ',
  '  ## ###  #####   ######  ####    #####  ',
  '  ##  ##  ##  ##  ##  ##  ##      ##     ',
  '  #####   ##  ##  ##  ##  ######  #######',
];

/** The wordmark lines (centered by the caller). */
export function logoLines(): string[] {
  return supportsUnicode() ? [...UNICODE_LOGO] : [...ASCII_LOGO];
}

/** A one-line compact wordmark for the status header. */
export function wordmark(): string {
  return 'GRACE';
}
