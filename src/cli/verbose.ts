/**
 * Verbose mode (GRACE UI).
 *
 * Normal mode keeps the terminal clean: concise progress, structured result
 * sections, collapsed long output. Verbose mode adds raw diagnostics — plan
 * steps, per-agent findings, full token counts, more diff lines — WITHOUT
 * ever printing secrets (API keys never exist in CLI rendering paths).
 *
 * State is module-level so the REPL can toggle it at runtime (/verbose) and
 * the CLI flags (--verbose) can seed it at startup.
 */
let enabled = false;

export function setVerbose(value: boolean): void {
  enabled = Boolean(value);
}

export function toggleVerbose(): boolean {
  enabled = !enabled;
  return enabled;
}

export function isVerbose(): boolean {
  return enabled;
}

/**
 * Internal diagnostics (provider failures, tool-call repair, …).
 *
 * Normal mode is clean: these lines NEVER reach the terminal or the TUI
 * activity feed. Verbose/debug mode prints them (scrubbed at the call site)
 * so operators can see exactly what happened. This is the ONLY sink internal
 * agent code should use instead of console.error.
 */
export function debugLog(...args: unknown[]): void {
  if (!enabled) return;
  // eslint-disable-next-line no-console
  console.error(...args);
}
