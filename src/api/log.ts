/**
 * Safe server-side request logging (Milestone 12 — observability).
 *
 * Logs operational facts only — never passwords, session tokens, API keys,
 * DATABASE_URL, request bodies, private project files or other sensitive user
 * data. Every free-text field passes through scrubForLogs() (which reuses the
 * safety layer's redactSecrets) before reaching the console, so a misbehaving
 * provider error or a strange prompt can never leak a secret into the logs.
 */
import { redactSecrets } from '../safety/policy.ts';

export interface ApiLogEvent {
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  /** Authenticated user id where appropriate (never the email or token). */
  userId?: string;
  model?: string;
  tokens?: { input: number; output: number };
  runId?: number;
  /** Free-text detail (errors, provider messages) — always scrubbed. */
  detail?: string;
}

/** Scrub free text for log output: secrets, credentialed URLs, bearer tokens. */
export function scrubForLogs(text: string): string {
  const cleaned = redactSecrets(text)
    .replace(/postgres(ql)?:\/\/[^\s"']+/gi, 'postgres://[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9_-]{16,}\b/gi, 'Bearer [REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .slice(0, 400)
    .trim();
  return cleaned || '[empty]';
}

/** Emit one structured, secret-safe log line for an API event. */
export function logApiEvent(evt: ApiLogEvent): void {
  const parts = [
    `method=${evt.method}`,
    `path=${evt.path}`,
    `status=${evt.status}`,
    `latency_ms=${evt.latencyMs}`,
  ];
  if (evt.userId) parts.push(`user_id=${evt.userId}`);
  if (evt.model) parts.push(`model=${scrubForLogs(evt.model)}`);
  if (evt.tokens) parts.push(`tokens_in=${evt.tokens.input} tokens_out=${evt.tokens.output}`);
  if (evt.runId !== undefined) parts.push(`run_id=${evt.runId}`);
  if (evt.detail) parts.push(`detail=${scrubForLogs(evt.detail)}`);
  // One line per event — grep-friendly for Vercel logs.
  console.log(`[api] ${parts.join(' ')}`);
}
