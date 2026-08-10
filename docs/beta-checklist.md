# Closed beta checklist (Milestone 12)

Run through this before inviting testers. Each item links to the command that
verifies it. Local items assume `npm install` + `npm run build` + `npm link`
are done.

## Local

- [ ] **Local tests passed** — `npm test` (all suites green)
- [ ] **Production build passed** — `npm run build` (emits `dist/`, no errors)
- [ ] **Typecheck passed** — `npm run typecheck`
- [ ] **Backend health check** — `npm run smoke` (prints `SMOKE OK`) or
      `npm run serve` + `curl localhost:8787/api/health` → `"status":"ok"`
- [ ] **Database migration** — apply `db/migrations/001_init.sql` …
      `004_free_sessions.sql` to Neon; verify with
      `SELECT COUNT(*) FROM users;` (existing data intact)
- [ ] **Free-plan sessions** — with a fresh account, `GET /api/usage` returns
      `sessionsUsed: 0`, `sessionsRemaining: 6`; one `/api/provider` request
      starts session 1 (`currentSession: 1`); after the 6th session the 7th
      returns `429` with `code: "daily_limit_exhausted"`
      (unit-tested in `tests/freeSessions.test.ts`)
- [ ] **Registration** — `zeesh register` → "Account created — logged in as …"
- [ ] **Login** — `zeesh login` → "Logged in as …"
- [ ] **Logout** — `zeesh logout` → "Logged out — local session removed."
- [ ] **Authenticated API** — `zeesh whoami` → "Status: valid"
- [ ] **Usage reporting** — run one agent task while logged in, then
      `SELECT COUNT(*) FROM usage;` on Neon (row appears; user_id matches)
- [ ] **Rate limiting** — `ZEESH_AUTH_RATE_LIMIT_MAX=3` + 5 failed logins →
      `429` with `Retry-After`
- [ ] **Security checks** — `npm test` covers: no plaintext passwords,
      hashed session tokens, cross-user access prevention, no stack traces in
      API errors, secret-safe logging
- [ ] **CLI installation** — fresh machine: `npm install` → `npm run build` →
      `npm link` → `zeesh --version` prints the version
- [ ] **Real project test** — ask the agent to create → modify → break → fix →
      verify a small app in a throwaway project (see
      `docs/validation-milestone-01.md` for the format)
- [ ] **Backend failure test** — stop the backend, run an agent task: the run
      completes locally and prints `usage report failed (backend offline)`
      (or nothing in non-TTY one-shot) without aborting
- [ ] **Cost tracking** — `SELECT * FROM user_economics;` shows runs, total
      tokens and `ai_cost_usd` per user (pricing source:
      `models` table — see `docs/economics.md`)

## Production (before inviting testers)

- [ ] Vercel project created and linked (`vercel link`)
- [ ] `DATABASE_URL` + `GROQ_API_KEY` set in Vercel env (production)
- [ ] Closed beta env set: `ZEESH_BETA_MODE=closed` + `ZEESH_BETA_ALLOWLIST`
- [ ] `vercel --prod` deployed
- [ ] `curl <prod>/api/health` → `database:"connected"`
- [ ] Allowlisted tester can register; non-allowlisted email gets `403`
- [ ] CLI points at production: `ZEESH_API_URL=<prod>` in `~/.zeesh/env`
- [ ] Tester login + one agent run recorded in Neon usage

## Go / no-go

- [ ] All local checks green
- [ ] All production checks green
- [ ] ~10–20 testers invited with their emails in `ZEESH_BETA_ALLOWLIST`
