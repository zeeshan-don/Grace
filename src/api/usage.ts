/**
 * Usage-recording service (Milestone 10).
 *
 * Records one agent run plus its token usage into Neon (`agent_runs` +
 * `usage`). Tracks at minimum: user_id, model, input_tokens, output_tokens,
 * agent_turns, timestamp (created_at) and execution_time_ms.
 *
 * The endpoint that feeds this service is authenticated-ready (Milestone 11
 * wires the CLI up behind real accounts); today it is safe to call and ready
 * for that wiring.
 */
import type { Db, Row } from './db.ts';

export type RunStatus = 'running' | 'done' | 'error' | 'denied';

export interface UsageReport {
  /** Client (CLI) id for the run — used as an idempotency key (unique). */
  client_run_id?: string;
  /** Placeholder until Milestone 11 real auth — then derived from the session. */
  user_id: string;
  session_id?: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  /** Number of reason→act→observe iterations in the agent loop. */
  agent_turns: number;
  tool_calls?: number;
  execution_time_ms?: number;
  project_type?: string;
  prompt?: string;
  status?: RunStatus;
}

/** A 4xx/5xx error with an HTTP status, thrown by the service layer. */
export class UsageError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RecordUsageResult {
  runId: number;
}

const MAX_PROMPT_CHARS = 20_000;
const VALID_STATUSES: ReadonlySet<string> = new Set(['running', 'done', 'error', 'denied']);

export class UsageService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * Insert an agent_run (+ usage) row. Returns the run id.
   *
   * Idempotency: a repeated `client_run_id` returns the existing run id and
   * does not record a second usage row.
   */
  async recordUsage(report: UsageReport): Promise<RecordUsageResult> {
    if (typeof report.user_id !== 'string' || report.user_id.trim() === '') {
      throw new UsageError(400, '"user_id" must be a non-empty string.');
    }
    if (typeof report.model !== 'string' || report.model.trim() === '') {
      throw new UsageError(400, '"model" must be a non-empty string.');
    }
    const user_id = report.user_id.trim();
    const model = report.model.trim();
    const status = report.status ?? 'done';

    if (!VALID_STATUSES.has(status)) throw new UsageError(400, `"status" must be one of: running, done, error, denied.`);
    if (!isNonNegativeInt(report.input_tokens)) throw new UsageError(400, '"input_tokens" must be a non-negative integer.');
    if (!isNonNegativeInt(report.output_tokens)) throw new UsageError(400, '"output_tokens" must be a non-negative integer.');
    if (!isNonNegativeInt(report.agent_turns)) throw new UsageError(400, '"agent_turns" must be a non-negative integer.');
    if (report.tool_calls !== undefined && !isNonNegativeInt(report.tool_calls)) {
      throw new UsageError(400, '"tool_calls" must be a non-negative integer.');
    }
    if (report.execution_time_ms !== undefined && !isNonNegativeInt(report.execution_time_ms)) {
      throw new UsageError(400, '"execution_time_ms" must be a non-negative integer.');
    }

    const runs = await this.db(
      `INSERT INTO agent_runs
         (client_run_id, user_id, session_id, project_type, prompt, status, model,
          agent_turns, tool_calls, input_tokens, output_tokens, execution_time_ms, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               CASE WHEN $6 = 'running' THEN NULL ELSE now() END)
       ON CONFLICT (client_run_id) DO NOTHING
       RETURNING id`,
      [
        report.client_run_id ?? null,
        user_id,
        report.session_id ?? null,
        report.project_type ?? null,
        report.prompt ? report.prompt.slice(0, MAX_PROMPT_CHARS) : null,
        status,
        model,
        report.agent_turns,
        report.tool_calls ?? 0,
        report.input_tokens,
        report.output_tokens,
        report.execution_time_ms ?? null,
      ],
    );

    let runId: number | null = null;
    if (runs.length === 1) {
      runId = Number(runs[0]?.id);
    } else if (report.client_run_id) {
      // Duplicate submission: reuse the existing run (no new usage row).
      const existing = await this.db(`SELECT id FROM agent_runs WHERE client_run_id = $1`, [report.client_run_id]);
      runId = Number(existing[0]?.id);
    }
    if (runId === null || !Number.isInteger(runId) || runId <= 0) {
      throw new UsageError(500, 'Could not determine the run id.');
    }

    if (runs.length === 1) {
      await this.db(
        `INSERT INTO usage (user_id, run_id, model, input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4, $5)`,
        [user_id, runId, model, report.input_tokens, report.output_tokens],
      );
    }

    return { runId };
  }

  /** Recent usage rows for one user (Milestone 11: sessions scope data per account). */
  async recentUsageForUser(userId: string, limit: number): Promise<Row[]> {
    return this.db(
      `SELECT u.id, u.user_id, u.run_id, u.model, u.input_tokens, u.output_tokens, u.created_at
         FROM usage u
        WHERE u.user_id = $1
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT $2`,
      [userId, limit],
    );
  }
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}
