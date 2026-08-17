"""Usage-recording service (port of src/api/usage.ts).

Records one agent run plus its token usage into Neon (`agent_runs` +
`usage`). Tracks at minimum: user_id, model, input_tokens, output_tokens,
agent_turns, timestamp (created_at) and execution_time_ms.
"""

from grace.server.db import Db

VALID_STATUSES = {"running", "done", "error", "denied"}
MAX_PROMPT_CHARS = 20_000


class UsageError(Exception):
    """A 4xx/5xx error with an HTTP status, thrown by the service layer."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status

    @property
    def message(self) -> str:
        """Mirrors the TS `err.message` accessor."""
        return str(self.args[0]) if self.args else ""


class UsageService:
    def __init__(self, db: Db) -> None:
        self.db = db

    def record_usage(self, report: dict) -> dict:
        """Insert an agent_run (+ usage) row. Returns {'runId': n}.

        Idempotency: a repeated `client_run_id` returns the existing run id and
        does not record a second usage row.
        """
        user_id = report.get("user_id")
        model = report.get("model")
        if not isinstance(user_id, str) or not user_id.strip():
            raise UsageError(400, '"user_id" must be a non-empty string.')
        if not isinstance(model, str) or not model.strip():
            raise UsageError(400, '"model" must be a non-empty string.')
        user_id = user_id.strip()
        model = model.strip()
        status = report.get("status") or "done"

        if status not in VALID_STATUSES:
            raise UsageError(400, '"status" must be one of: running, done, error, denied.')
        if not _is_non_negative_int(report.get("input_tokens")):
            raise UsageError(400, '"input_tokens" must be a non-negative integer.')
        if not _is_non_negative_int(report.get("output_tokens")):
            raise UsageError(400, '"output_tokens" must be a non-negative integer.')
        if not _is_non_negative_int(report.get("agent_turns")):
            raise UsageError(400, '"agent_turns" must be a non-negative integer.')
        if report.get("tool_calls") is not None and not _is_non_negative_int(report.get("tool_calls")):
            raise UsageError(400, '"tool_calls" must be a non-negative integer.')
        if report.get("execution_time_ms") is not None and not _is_non_negative_int(report.get("execution_time_ms")):
            raise UsageError(400, '"execution_time_ms" must be a non-negative integer.')

        prompt = report.get("prompt")
        runs = self.db(
            "INSERT INTO agent_runs"
            "   (client_run_id, user_id, session_id, project_type, prompt, status, model,"
            "    agent_turns, tool_calls, input_tokens, output_tokens, execution_time_ms, finished_at)"
            " VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,"
            "         CASE WHEN $6 = 'running' THEN NULL ELSE now() END)"
            " ON CONFLICT (client_run_id) DO NOTHING"
            " RETURNING id",
            [
                report.get("client_run_id") or None,
                user_id,
                report.get("session_id") or None,
                report.get("project_type") or None,
                prompt[:MAX_PROMPT_CHARS] if prompt else None,
                status,
                model,
                report.get("agent_turns"),
                report.get("tool_calls") or 0,
                report.get("input_tokens"),
                report.get("output_tokens"),
                report.get("execution_time_ms") or None,
            ],
        )

        run_id = None
        if len(runs) == 1:
            run_id = _as_int(runs[0].get("id"))
        elif report.get("client_run_id"):
            # Duplicate submission: reuse the existing run (no new usage row).
            existing = self.db("SELECT id FROM agent_runs WHERE client_run_id = $1", [report["client_run_id"]])
            run_id = _as_int(existing[0].get("id")) if existing else None
        if run_id is None or not isinstance(run_id, int) or run_id <= 0:
            raise UsageError(500, "Could not determine the run id.")

        if len(runs) == 1:
            self.db(
                "INSERT INTO usage (user_id, run_id, model, input_tokens, output_tokens)"
                " VALUES ($1, $2, $3, $4, $5)",
                [user_id, run_id, model, report.get("input_tokens"), report.get("output_tokens")],
            )

        return {"runId": run_id}

    def recent_usage_for_user(self, user_id: str, limit: int) -> list[dict]:
        """Recent usage rows for one user (sessions scope data per account)."""
        return self.db(
            "SELECT u.id, u.user_id, u.run_id, u.model, u.input_tokens, u.output_tokens, u.created_at"
            "   FROM usage u"
            "  WHERE u.user_id = $1"
            "  ORDER BY u.created_at DESC, u.id DESC"
            "  LIMIT $2",
            [user_id, limit],
        )


def _is_non_negative_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _as_int(v) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None
