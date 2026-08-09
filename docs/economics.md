# Usage & economics (Milestones 10–12)

The database records everything needed to calculate **AI cost per user** and
**AI cost per agent run**. This page documents exactly where each piece lives
and where pricing assumptions are stored.

## Where pricing assumptions live

Model prices are stored in the **`models` table** (`db/migrations/001_init.sql`),
**not** hardcoded in application code. Every model the agent uses has a row
with `input_ppm_usd` and `output_ppm_usd` (USD per 1M tokens):

```sql
SELECT id, provider, input_ppm_usd, output_ppm_usd FROM models;
```

Seed values are placeholder estimates from the current Groq catalog. To update
pricing (e.g. when a provider changes prices), upsert the row:

```sql
INSERT INTO models (id, provider, input_ppm_usd, output_ppm_usd, context_tokens)
VALUES ('openai/gpt-oss-120b', 'groq', 0.25, 1.00, 131072)
ON CONFLICT (id) DO UPDATE SET
  input_ppm_usd = EXCLUDED.input_ppm_usd,
  output_ppm_usd = EXCLUDED.output_ppm_usd;
```

Unknown models cost `$0` (the `COALESCE(m.input_ppm_usd, 0)` in the view) —
add a row before drawing conclusions about a new model.

## What each run records

Every authenticated agent run creates one row in `agent_runs` (+ one in
`usage`), carrying:

```
user_id · model · input_tokens · output_tokens · agent_turns ·
created_at (timestamp) · execution_time_ms
```

plus `client_run_id` (idempotency), `session_id`, `project_type`, `prompt`
(truncated to 20k chars — never logged, only stored in the DB for analysis),
`status`, `tool_calls` and `finished_at`.

## Cost views

The **`user_economics`** view (migration 001) computes per-user economics:

```sql
SELECT * FROM user_economics ORDER BY ai_cost_usd DESC;
```

| Column | Meaning |
| ------ | ------- |
| `user_id` | The account |
| `runs` | Distinct agent runs |
| `total_tokens` | Sum of input + output tokens |
| `ai_cost_usd` | Estimated AI inference cost (input + output priced from `models`) |

Per-run cost is derivable the same way:

```sql
SELECT r.id AS run_id, r.user_id, r.model,
       ROUND((r.input_tokens::numeric / 1000000) * m.input_ppm_usd
           + (r.output_tokens::numeric / 1000000) * m.output_ppm_usd, 6) AS cost_usd
FROM agent_runs r LEFT JOIN models m ON m.id = r.model
ORDER BY r.id DESC;
```

## Beta observability (Milestone 12)

Enough to run a ~10–20 user closed beta without a dashboard:

- **Identify users** — `users` + `users.is_beta` (beta flag set from
  `ZEESH_BETA_MODE` / `ZEESH_BETA_ALLOWLIST` at registration).
- **Track agent usage** — `agent_runs` + `usage` rows (reported automatically
  by the CLI after each run while logged in).
- **Monitor errors** — server request logs (`[api] method=… status=…`) and
  run `status` values (`done` / `error` / `denied` / `running`).
- **Understand model usage** — `model` column per run + `models` catalog.
- **Understand agent runs** — `agent_turns`, `tool_calls`,
  `execution_time_ms`, `prompt` per run.
- **Approximate AI cost** — `user_economics` view.

## What is deliberately NOT implemented

Advertising, ad tracking/targeting, payments, subscriptions, premium plans and
billing are out of scope until real usage + cost data exists (Milestones
13–14). The `usage.cost_usd` column is reserved for the billing pipeline.
