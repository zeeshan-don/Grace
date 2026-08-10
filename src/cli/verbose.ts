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
