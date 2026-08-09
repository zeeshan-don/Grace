/** Minimal ANSI color helpers with automatic disabling for non-TTY / NO_COLOR. */
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const codes = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

type Code = keyof typeof codes;

function paint(code: Code, text: string): string {
  if (!useColor) return text;
  return codes[code] + text + codes.reset;
}

export const c = {
  dim: (t: string) => paint('dim', t),
  bold: (t: string) => paint('bold', t),
  red: (t: string) => paint('red', t),
  green: (t: string) => paint('green', t),
  yellow: (t: string) => paint('yellow', t),
  blue: (t: string) => paint('blue', t),
  magenta: (t: string) => paint('magenta', t),
  cyan: (t: string) => paint('cyan', t),
  gray: (t: string) => paint('gray', t),
};

export const isTty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
