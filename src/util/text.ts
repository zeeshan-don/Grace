/** Small shared text helpers used across tools, context and CLI. */

/** Rough token estimate: ~4 chars per token for mixed source code. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Truncate long text to maxChars, appending a note so consumers know it was cut. */
export function truncateText(text: string, maxChars: number, note = '\n… [truncated]'): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + note;
}

/** Truncate preserving the head and tail (useful for logs/diffs). */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2) - 10;
  return `${text.slice(0, half)}\n… [truncated ${text.length - maxChars + 20} chars] …\n${text.slice(-half)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render an absolute path relative to the user's home directory (or as-is). */
export function shortPath(p: string, home: string): string {
  if (p === home) return '~';
  if (p.startsWith(home + '/') || p.startsWith(home + '\\')) return `~${p.slice(home.length)}`;
  return p;
}
