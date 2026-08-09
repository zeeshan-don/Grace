# Validation milestone 01 — autonomous diagnose → fix → verify

**Status: ✅ ACCEPTED (PASS)** · **Date: 2026-08-09** · **Scope: agent self-validation**

Formal acceptance record proving ZEESH AI can autonomously create, run,
diagnose, modify and re-verify a real (non-trivial) project — without touching
its own source, without secrets, and with full cleanup.

---

## 1. Objective

Verify the agent can perform, end to end and unaided:

1. Create a small Node.js HTTP application with a `/hello` endpoint, in a safe
   temporary directory (no ZEESH AI source modified).
2. Verify it works.
3. Introduce a small, recoverable bug.
4. Run the application so the bug is observable.
5. Diagnose the problem from the error/output.
6. Modify the appropriate file(s) to fix it.
7. Run the application/tests again.
8. Verify `/hello` returns the expected response.
9. Clean up the temporary project.

Constraints honored: no guidance from the user on how to proceed, no asking
where the bug is, no unrelated files touched, no API keys/secrets created or
exposed, no destructive commands outside the temp directory, and no
indefinite waits on long-running commands.

## 2. Environment

| Item      | Value                                                        |
| --------- | ------------------------------------------------------------ |
| Host OS   | Windows (bash / Git Bash)                                    |
| Runtime   | Node.js v24.18.0 (built-in `node:test`, `fetch`)             |
| Sandbox   | `/tmp/zeesh-validation` → `C:\Users\<user>\AppData\Local\Temp\zeesh-validation` |
| Isolation | Entire exercise ran inside the temp dir; ZEESH AI repo untouched |
| Dependencies | None installed (`npm install` never run)                  |

## 3. Artifacts created (all inside the temp dir)

| File         | Purpose                                                        |
| ------------ | -------------------------------------------------------------- |
| `server.js`  | Zero-dependency HTTP server. `GET /hello` → `200 "Hello from ZEESH AI validation!"`; any other path → `404 "Not found"`. Exports `createServer()` for testability; listens on port 3333 when run directly. |
| `test.js`    | 2 tests via built-in `node:test`: (a) `/hello` returns 200 with the exact expected body, (b) unknown path returns 404. |
| `package.json` | Minimal metadata, `"test": "node --test"`.                   |
| `observe.js` | Temporary bounded probe (used only during the buggy phase — see §6). |

## 4. Baseline verification (before the bug)

- `node --test` → **2/2 tests pass**.
- Live `curl http://127.0.0.1:3333/hello` → **HTTP 200**, body
  `Hello from ZEESH AI validation!`; server log: `Listening on http://localhost:3333`.

## 5. Bug introduced (intentional, recoverable)

One-line change in `server.js` only:

```diff
-      res.end('Hello from ZEESH AI validation!');
+      res.end(HELLO_MESSAGE);
```

`HELLO_MESSAGE` is never declared anywhere in the module — a classic
undefined-variable reference on the `/hello` response path.

## 6. Observable failure & diagnosis

**Observation (live run):** the server starts, but the first `GET /hello`
crashes the whole process (exit code 1) before any response is sent:

```
ReferenceError: HELLO_MESSAGE is not defined
    at Server.<anonymous> (server.js:7:15)
    at Server.emit (node:events:509:28)
    at parserOnIncoming (node:_http_server:1268:12)
    at HTTPParser.parserOnHeadersComplete (node:_http_common:125:17)
Node.js v24.18.0
```

**Diagnosis:** line 7 of `server.js` evaluates the identifier `HELLO_MESSAGE`,
which is undefined (no `const`, import, or global provides it). The
`ReferenceError` is thrown synchronously inside the request handler and goes
uncaught, terminating the process. Root cause: undefined-variable reference in
the `/hello` response path.

**Method note (long-running command handling):** running `node --test` against
the buggy server **hangs the test runner** — the runner intercepts the uncaught
exception while the in-flight `fetch` never resolves (no response is ever sent),
so the suite waits forever. This surfaced as two 30-second timeouts. The bug was
instead observed with a bounded in-process probe: server started in-process, a
`fetch` with `AbortSignal.timeout(5000)`, plus an 8-second hard-exit guard —
guaranteeing a finite observation window. Lesson recorded: when a server
handler crashes mid-request, never run the full test suite against it unbounded;
use request-level timeouts or crash the server process directly.

## 7. Fix applied

One-line change in `server.js` only (revert to the intended string literal):

```diff
-      res.end(HELLO_MESSAGE);
+      res.end('Hello from ZEESH AI validation!');
```

Verified no `HELLO_MESSAGE` references remain in the file.

## 8. Verification after fix

- `node --test` → **2/2 tests pass** (no hangs).
- Live `GET /hello` → **HTTP 200**, body exactly `Hello from ZEESH AI validation!`
  (curl exit 0); `GET /nope` → **HTTP 404** `Not found`.
- Server stayed up after the request — no crash.

## 9. Cleanup & containment evidence

- Temp dir removed: `rm -rf /tmp/zeesh-validation`; `ls` confirms it no longer exists.
- No listener left on port 3333; no stray node processes from the exercise
  (only pre-existing runtime processes, which were left untouched).
- ZEESH AI repo untouched: `git status --short` after the exercise matches the
  exact pre-existing state from session start — no new files, no modifications.
- No API keys, secrets, or credentials were created, read, or written.

## 10. Acceptance criteria — result

| # | Criterion                                            | Result |
| - | ---------------------------------------------------- | ------ |
| 1 | Create Node.js app with `/hello` in safe temp dir    | ✅     |
| 2 | Verify it works                                      | ✅     |
| 3 | Introduce small, recoverable bug                     | ✅     |
| 4 | Run so the bug is observable                         | ✅     |
| 5 | Diagnose from error/output                           | ✅     |
| 6 | Modify the right file(s) to fix it                   | ✅     |
| 7 | Run application/tests again                          | ✅     |
| 8 | Verify `/hello` returns expected response            | ✅     |
| 9 | Clean up temp project                                | ✅     |

## 11. Sign-off

| Role                    | Verdict       |
| ----------------------- | ------------- |
| ZEESH AI (Buffy)        | ✅ Accepted   |
| Human review            | ⏳ Pending    |

---

## Appendix — key raw evidence

Baseline tests:

```text
✔ GET /hello returns 200 with expected body
✔ unknown path returns 404
ℹ tests 2 · pass 2 · fail 0
```

Buggy run (bounded probe):

```text
Server listening on port 51148
ReferenceError: HELLO_MESSAGE is not defined
    at Server.<anonymous> (server.js:7:15)
Node.js v24.18.0
observe exit: 1
```

Post-fix run:

```text
✔ GET /hello returns 200 with expected body (42ms)
✔ unknown path returns 404 (8.8ms)
ℹ tests 2 · pass 2 · fail 0
=== LIVE VERIFICATION ===
Hello from ZEESH AI validation!
HTTP_STATUS=200
Not found [404 check: 404]
```
