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

/** Render an elapsed duration compactly, e.g. 312ms, 4.2s, 1m 12s. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m ${Math.round(seconds % 60)}s`;
}

/** Render an absolute path relative to the user's home directory (or as-is). */
export function shortPath(p: string, home: string): string {
  if (p === home) return '~';
  if (p.startsWith(home + '/') || p.startsWith(home + '\\')) return `~${p.slice(home.length)}`;
  return p;
}
