/**
 * Milestone 12 end-to-end harness (temporary — deleted after validation).
 *
 * Proves, with the ACTUAL built CLI (dist/index.js) and a REAL Groq key:
 *   1. login (via ApiClient + persisted session)           → auth works
 *   2. create a small app                                  → agent works
 *   3. modify it                                           → agent works
 *   4. fix a controlled bug                                → diagnose/fix loop
 *   5. usage reporting reaches the backend (memory DB)     → cost tracking data
 *   6. the local agent still works with the backend DOWN   → offline resilience
 *
 * The backend is the real handlers (src/api/server.ts) with the in-memory Db
 * test double — the only stand-in is the database itself (no Neon credentials
 * in this environment); the CLI talks to it over real HTTP.
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { setDbForTests } from '../src/api/db.ts';
import { createApiServer } from '../src/api/server.ts';
import { ApiClient } from '../src/auth/client.ts';
import { saveSession } from '../src/auth/session.ts';
import { createMemoryDb } from '../tests/helpers/memoryDb.ts';

const ROOT = process.cwd();
dotenv.config({ path: join(ROOT, '.env') });

const GROQ_KEY = process.env.GROQ_API_KEY?.trim();
const DIST = join(ROOT, 'dist', 'index.js');

const results: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '✔' : '✖'} ${label}${detail ? ` (${detail})` : ''}`);
}

async function main(): Promise<void> {
  if (!GROQ_KEY) {
    console.log('NO GROQ_API_KEY in .env — cannot run the real E2E. Aborting.');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(DIST)) {
    console.log('dist/ missing — run npm run build first. Aborting.');
    process.exitCode = 1;
    return;
  }

  // ---- throwaway project + temp HOME for the CLI session -------------------
  const project = mkdtempSync(join(tmpdir(), 'zeesh-m12-e2e-'));
  const tempHome = mkdtempSync(join(tmpdir(), 'zeesh-m12-home-'));
  mkdirSync(join(tempHome, '.zeesh'), { recursive: true });
  console.log(`throwaway project: ${project}`);

  // ---- backend with the in-memory DB on a real port -------------------------
  const mem = createMemoryDb();
  setDbForTests(mem.db);
  const server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const apiUrl = `http://127.0.0.1:${port}`;
  console.log(`backend on ${apiUrl} (in-memory Db)`);

  const cliEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GROQ_API_KEY: GROQ_KEY,
    ZEESH_API_URL: apiUrl,
    USERPROFILE: tempHome, // os.homedir() → temp HOME on Windows
    HOME: tempHome,
    NO_COLOR: '1',
  };

  // IMPORTANT: async execFile — the parent's event loop must stay free so the
  // API server (same process) can answer the CLI's usage-report requests while
  // a CLI task is running. spawnSync would deadlock that.
  const logsDir = join(tmpdir(), 'zeesh-m12-logs');
  mkdirSync(logsDir, { recursive: true });
  const runCli = (label: string, prompt: string, timeoutMs = 240_000): Promise<{ ok: boolean; out: string }> =>
    new Promise((resolve) => {
      execFile(
        'node',
        [DIST, prompt],
        {
          cwd: project,
          env: cliEnv,
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const out = (stdout ?? '') + (stderr ?? '');
          try {
            writeFileSync(join(logsDir, `${label}.log`), out, 'utf8');
          } catch {
            // best-effort
          }
          if (error) resolve({ ok: false, out: out || `ERROR: ${(error as Error).message}` });
          else resolve({ ok: true, out });
        },
      );
    });

  try {
    // 1. login (register → persist session exactly like `grace login` does)
    const client = new ApiClient(apiUrl, 8000);
    const auth = await client.register('e2e@example.com', 'hunter2-strong', 'E2E Tester');
    saveSession(
      {
        apiUrl,
        token: auth.token,
        user: { id: auth.user.id, email: auth.user.email, displayName: auth.user.display_name },
        expiresAt: auth.expires_at,
        createdAt: new Date().toISOString(),
      },
      join(tempHome, '.zeesh', 'auth.json'),
    );
    check('register + persisted session', true, auth.user.email);
    check('backend knows the session', (await client.me(auth.token)).email === 'e2e@example.com');

    const NO_SERVER = 'Never start a long-running server. If you verify anything, use a short `node -e` snippet that exits immediately.';

    // 2. create a small application
    const t1 = await runCli(
      'T1',
      `Create a minimal Node.js HTTP app in this project: write server.js that exports createServer and replies "Hello from M12!" on GET /hello; write package.json with a start script. ${NO_SERVER}`,
    );
    check('T1 create app (agent run 1)', t1.ok, `exit=${t1.ok ? '0' : 'failed'}`);
    const serverJs = join(project, 'server.js');
    check('T1 server.js exists', existsSync(serverJs));

    // 3. modify the app (add /health)
    const t2 = await runCli(
      'T2',
      `Add a GET /health endpoint to server.js that replies HTTP 200 with the body "ok". Do not change /hello. ${NO_SERVER}`,
    );
    check('T2 modify app (agent run 2)', t2.ok);
    check('T2 /health added', existsSync(serverJs) && readFileSync(serverJs, 'utf8').includes('/health'));

    // 4. controlled bug injected by the harness, then agent fixes it
    let source = readFileSync(serverJs, 'utf8');
    source = source.replace('Hello from M12!', 'Hello from M12! BROKEN');
    writeFileSync(serverJs, source);
    check('bug injected', true, 'greeting now says BROKEN');
    const t3 = await runCli(
      'T3',
      `There is a bug: GET /hello returns a body containing "BROKEN". Diagnose the bug in server.js and fix it so /hello replies exactly "Hello from M12!" and /health still replies "ok". ${NO_SERVER}`,
    );
    check('T3 diagnose+fix (agent run 3)', t3.ok);
    check('T3 bug removed', existsSync(serverJs) && !readFileSync(serverJs, 'utf8').includes('BROKEN'));

    // 5. verify the app actually works (handles both CJS and ESM server.js)
    const verifyScript = [
      "const { pathToFileURL } = require('node:url');",
      '(async () => {',
      '  const mod = await import(pathToFileURL(process.argv[1]).href);',
      '  const { createServer } = mod.createServer ? mod : mod.default;',
      '  const s = createServer();',
      "  s.listen(0, '127.0.0.1', async () => {",
      "    const { port } = s.address();",
      "    const h = await fetch('http://127.0.0.1:' + port + '/hello');",
      '    const b = await h.text();',
      "    console.log('HELLO', h.status, JSON.stringify(b));",
      '    s.close();',
      '  });',
      '})().catch((e) => { console.error(e); process.exit(1); });',
    ].join('\n');
    const verify = spawnSync('node', ['-e', verifyScript, serverJs], {
      cwd: project,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const helloOk = verify.stdout?.includes('HELLO 200 "Hello from M12!"') ?? false;
    check('app verified: GET /hello → 200 "Hello from M12!"', helloOk, verify.stdout?.trim().slice(0, 80) ?? 'no output');

    // 6. usage reporting reached the backend (3 runs, all for the session user)
    check('backend recorded 3 agent runs', mem.runs.length >= 3, `${mem.runs.length} run(s)`);
    check('usage rows recorded', mem.usageRows.length >= 3, `${mem.usageRows.length} row(s)`);
    const allMine = mem.runs.every((r) => r.user_id === auth.user.id);
    check('all runs scoped to the session user', allMine);

    // 7. backend unavailable → local agent keeps working
    server.close();
    setDbForTests(null);
    const t4 = await runCli('T4', `Change the /hello greeting in server.js to "Hello from M12 offline!". ${NO_SERVER}`);
    const sawOfflineNote = t4.out.includes('usage report failed');
    check('T4 offline run (backend down)', t4.ok, sawOfflineNote ? 'saw offline note' : 'ran to completion');
    check(
      'T4 change applied offline',
      existsSync(serverJs) && readFileSync(serverJs, 'utf8').includes('Hello from M12 offline!'),
    );

    // 8. cleanup
    rmSync(project, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
    check('cleanup complete', !existsSync(project));
  } catch (err) {
    check('harness error', false, err instanceof Error ? err.message : String(err));
  } finally {
    try {
      server.close();
    } catch {
      // already closed
    }
    setDbForTests(null);
  }

  console.log('\n================ E2E SUMMARY ================');
  for (const r of results) console.log(r);
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

void main();
