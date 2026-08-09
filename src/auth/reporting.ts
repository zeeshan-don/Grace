/**
 * Usage reporting (Milestone 11).
 *
 * After each agent run the CLI reports usage to the backend when a valid
 * session exists. Reporting is deliberately fire-and-forget safe:
 *   - never throws (the agent keeps working no matter what),
 *   - short timeout so it cannot hang the terminal,
 *   - skips silently when the user is not logged in (pure offline mode),
 *   - clears the local session when the backend says the token is invalid.
 */
import { randomUUID } from 'node:crypto';
import type { Usage } from '../providers/types.ts';
import { ApiClient, ApiError, type UsageReportPayload } from './client.ts';
import { clearSession, loadSession, sessionExpired, type StoredSession } from './session.ts';

export interface RunReportInput {
  prompt: string;
  model: string;
  projectType: string;
  sessionId?: string;
  iterations: number;
  toolCalls: number;
  usage?: Usage;
  executionTimeMs: number;
}

export type ReportOutcome = 'reported' | 'skipped' | 'failed';

/** Build the /api/usage payload from an agent run. Returns null when there is no usage to report. */
export function buildUsageReport(input: RunReportInput): UsageReportPayload | null {
  if (!input.usage) return null;
  return {
    client_run_id: randomUUID(),
    user_id: '', // replaced by sendUsageReport with the session user's id
    session_id: input.sessionId,
    project_type: input.projectType || undefined,
    prompt: input.prompt,
    status: 'done',
    model: input.model,
    agent_turns: input.iterations,
    tool_calls: input.toolCalls,
    input_tokens: input.usage.inputTokens,
    output_tokens: input.usage.outputTokens,
    execution_time_ms: input.executionTimeMs,
  };
}

/**
 * Send a report for an already-loaded session. Never throws.
 * `clear` is the local-session removal hook (injectable for tests).
 */
export async function sendUsageReport(
  session: StoredSession,
  report: UsageReportPayload,
  clear: () => void = clearSession,
): Promise<ReportOutcome> {
  try {
    const payload: UsageReportPayload = { ...report, user_id: session.user.id };
    // Short timeout: reporting is best-effort and must never stall the CLI.
    await new ApiClient(session.apiUrl, 3000).reportUsage(session.token, payload);
    return 'reported';
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) clear();
    return 'failed';
  }
}

/**
 * Report one agent run when authenticated. Returns the outcome; callers may
 * `await` it (bounded by the client timeout) or fire-and-forget.
 */
export async function reportRunUsage(
  input: RunReportInput,
  sessionOverride?: StoredSession | null,
  clear: () => void = clearSession,
): Promise<ReportOutcome> {
  const session = sessionOverride !== undefined ? sessionOverride : loadSession();
  if (!session) return 'skipped';
  if (sessionExpired(session)) {
    clear();
    return 'skipped';
  }
  const report = buildUsageReport(input);
  if (!report) return 'skipped';
  return sendUsageReport(session, report, clear);
}
