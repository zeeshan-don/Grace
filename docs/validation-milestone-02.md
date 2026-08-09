# Validation milestone 02 — closed-beta end-to-end (Milestone 12)

**Status: ✅ ACCEPTED (PASS)** · **Date: 2026-08-09** · **Scope: agent +
backend self-validation**

Reproduces with `node scripts/e2e-m12.ts` (uses your real `GROQ_API_KEY`).

## What was proven

| # | Check | Result |
| -- | ----- | ------ |
| 1 | Register + persisted session (`myagent login` equivalent) | ✅ |
| 2 | Backend resolves the session (`/api/auth/me`) | ✅ |
| 3 | Real CLI + Groq **creates** a small Node HTTP app (`server.js` + `package.json`) | ✅ |
| 4 | Real CLI **modifies** it (adds `GET /health`) | ✅ |
| 5 | Controlled bug injected (greeting says `BROKEN`) | ✅ |
| 6 | Real CLI **diagnoses and fixes** the bug (auto error-fix loop) | ✅ |
| 7 | App verified live: `GET /hello` → `200 "Hello from M12!"` | ✅ |
| 8 | Usage reporting reached the backend — 3 `agent_runs` + 3 `usage` rows | ✅ |
| 9 | All runs scoped to the authenticated user (cross-user prevention) | ✅ |
| 10 | **Backend down** → local agent still runs, prints a non-fatal note | ✅ |
| 11 | Offline change applied; throwaway project + temp session cleaned up | ✅ |

## Environment

- Real CLI: `dist/index.js` (built) — **not** run from source
- Real AI: Groq (`openai/gpt-oss-120b`), key from `.env`, never logged
- Backend: real handlers (`src/api/server.ts`) on a real HTTP port with the
  in-memory Db test double (the only stand-in — no Neon credentials in this
  environment; the CLI ↔ API path is real HTTP)
- OS: Windows; throwaway project in the OS temp dir

## Observed server log (observability, Milestone 12)

```
[api] method=POST path=/api/usage status=201 latency_ms=0 user_id=… model=openai/gpt-oss-120b tokens_in=2846 tokens_out=179 run_id=2
```

Scrubbed, one line per request; no secrets, no tokens, no prompts.

## Notes

- The agent was told never to start long-running servers, so verification used
  short `node -e` snippets (a blocking `node server.js` would hit the 120s
  `run_command` timeout).
- The harness uses async `execFile` on purpose: the API server runs in the
  same process as the CLI runner, so a synchronous `spawnSync` would freeze
  the event loop and stall usage reporting.
