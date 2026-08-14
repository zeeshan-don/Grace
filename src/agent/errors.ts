/**
 * Task-run error taxonomy (agent loop).
 *
 * The loop classifies every failure into one of these categories so the UI
 * reports the ACTUAL failure (an invalid tool call is not a provider outage).
 * All messages are scrubbed before they reach the session/UI — never a raw
 * SDK error that could echo an API key.
 */
import { scrub } from '../providers/errors.ts';

export type TaskRunErrorCategory =
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_authentication'
  | 'invalid_tool_call'
  | 'tool_execution'
  | 'task_cancelled';

export interface TaskRunError {
  category: TaskRunErrorCategory;
  /** Scrubbbed, user-safe detail (never contains a secret). */
  message: string;
  providerId?: string;
  providerLabel?: string;
  modelId?: string;
  /** Sanitized raw tool-call arguments (invalid_tool_call diagnostics only). */
  rawArguments?: string;
}

/** Short, human-safe label for each category (used by the UI). */
export const TASK_ERROR_LABELS: Record<TaskRunErrorCategory, string> = {
  provider_unavailable: 'Provider unavailable',
  provider_timeout: 'Provider timeout',
  provider_authentication: 'Provider authentication error',
  invalid_tool_call: 'Invalid tool call',
  tool_execution: 'Tool execution error',
  task_cancelled: 'Task cancelled',
};

/** One user-safe sentence per category (never chain-of-thought). */
export function describeRunErrorCategory(category: TaskRunErrorCategory): string {
  switch (category) {
    case 'provider_unavailable':
      return 'The AI provider could not be reached.';
    case 'provider_timeout':
      return 'The AI provider timed out.';
    case 'provider_authentication':
      return 'The AI provider rejected the request (authentication failed).';
    case 'invalid_tool_call':
      return 'The agent received malformed arguments for a tool call and could not safely execute it.';
    case 'tool_execution':
      return 'A tool failed while executing.';
    case 'task_cancelled':
      return 'The task was cancelled.';
  }
}

/**
 * Classify a raw provider error message into the taxonomy. Rate limits are
 * retried by the loop and never surface here; this covers everything else.
 */
export function classifyProviderError(message: string): TaskRunErrorCategory {
  const m = message.toLowerCase();
  if (/(timed? ?out|timeout|etimedout|408|504|deadline exceeded)/.test(m)) return 'provider_timeout';
  if (/(401|403|authentication|unauthorized|invalid api key|incorrect api key|api key.*(invalid|rejected))/i.test(m)) {
    return 'provider_authentication';
  }
  return 'provider_unavailable';
}

/** Build a scrubbed TaskRunError from a raw provider error message. */
export function providerError(
  message: string,
  provider: { id: string; label: string; modelId: string },
): TaskRunError {
  return {
    category: classifyProviderError(message),
    message: scrub(message),
    providerId: provider.id,
    providerLabel: provider.label,
    modelId: provider.modelId,
  };
}

/** Human-readable multi-line rendering for a classified failure. */
export function formatRunError(error: TaskRunError): string {
  const parts = [describeRunErrorCategory(error.category)];
  if (error.message) parts.push(error.message);
  return parts.join('\n');
}
