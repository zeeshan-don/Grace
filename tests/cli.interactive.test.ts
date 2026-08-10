/**
 * CLI interactive + one-shot E2E tests (Milestone 12).
 *
 * A mock HTTP server stands in for the GRACE backend so we can exercise
 * the full agent loop (RemoteProvider → AgentLoop → tools → loop back) with
 * no real provider key.
 *
 * The existing cli.test.ts covers --version and --help; this file covers the
 * interactive and one-shot flows.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { clearSession, saveSession } from '../src/auth/session.ts';
import type { ChatMessage, ToolCallParam } from '../src/providers/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENTRY = join(process.cwd(), 'src', 'index.ts');

/**
 * Isolated home for every test so the CLI never touches the real user's
 * config.  Also a shared working directory (each test gets a fresh sub-dir).
 */
const home = mkdtempSync(join(tmpdir(), 'zeesh-inter-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'zeesh-inter-workspace-'));

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

/** Default env: isolated home, no colors, no accidental local key. */
const ENV: Record<string, string> = {
  ...process.env as Record<string, string>,
  HOME: home,
  USERPROFILE: home,
  NO_COLOR: '1',
  // Deterministic glyphs regardless of platform/TTY (the ASCII fallback path
  // is covered by the dedicated ui tests).
  ZEESH_UNICODE: '1',
  // Ensure no local key leaks from the test runner's environment.
  GROQ_API_KEY: '',
};

/** Create a fresh workdir for a single test. */
function freshDir(): string {
  return mkdtempSync(join(workspace, 'work-'));
}

// ---------------------------------------------------------------------------
// Mock backend
// ---------------------------------------------------------------------------

const running: Server[] = [];

afterEach(() => {
  for (const s of running.splice(0)) s.close();
});

type BackendMode = 'happy' | 'fail';

/**
 * Start a mock GRACE backend that responds to POST /api/provider.
 *
 * - `happy`: first request returns a write_file tool call, second returns a
 *   completion message (simulating a real agent run).
 * - `fail`: all requests return 500 so the agent loop surfaces the error.
 */
function startBackend(mode: BackendMode): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) : {};

      if (req.url === '/api/provider' && req.method === 'POST') {
        if (mode === 'fail') {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'server boom' }));
          return;
        }

        // Happy path: first call → tool call; second call → completion.
        const messages = (body as { messages?: ChatMessage[] }).messages ?? [];
        const hasToolResult = messages.some((m) => m.role === 'tool');

        if (!hasToolResult) {
          const toolCall: ToolCallParam = {
            id: 'call_1',
            name: 'write_file',
            arguments: JSON.stringify({ path: 'hello.py', content: "print('hello from grace')\n" }),
          };
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ content: null, tool_calls: [toolCall], finish_reason: 'tool_calls' }));
        } else {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            content: 'Created hello.py — run it with: python3 hello.py',
            tool_calls: [],
            finish_reason: 'stop',
          }));
        }
        return;
      }

      // Accept usage reports gracefully (tests may fire-and-forget them).
      if (req.url === '/api/usage' && req.method === 'POST') {
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ recorded: true }));
        return;
      }

      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      running.push(server);
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/** Write a session file into the isolated home so the CLI logs in. */
function writeSession(baseUrl: string): void {
  saveSession(
    {
      apiUrl: baseUrl,
      token: 't'.repeat(64),
      user: { id: 'u-1', email: 'dev@example.com', displayName: null },
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: new Date().toISOString(),
    },
    join(home, '.zeesh', 'auth.json'),
  );
}

/** Clear the session file in the isolated home. */
function clearSessionFile(): void {
  clearSession(join(home, '.zeesh', 'auth.json'));
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  opts: { cwd?: string; stdin?: string; timeout?: number } = {},
): Promise<RunResult> {
  const { cwd: dir = freshDir(), stdin, timeout = 20_000 } = opts;
  return new Promise((resolve) => {
    const child = spawn('node', [ENTRY, ...args], { env: ENV, cwd: dir });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, stdout, stderr: stderr + '\n[timeout]' });
    }, timeout);
    child.stdout.on('data', (d: Buffer) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += String(d);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + '\n' + String(err) });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---- One-shot mode --------------------------------------------------------

test('one-shot: argument mode still works (no provider → error)', async () => {
  clearSessionFile();
  const { code, stdout } = await runCli(['Fix the login bug']);
  assert.equal(code, 1, 'exits with error when no provider is configured');
  assert.match(stdout, /No AI provider configured/);
  assert.match(stdout, /one-shot run/);
});

test('one-shot: E2E with mock backend (agent loop writes hello.py)', async () => {
  const backend = await startBackend('happy');
  writeSession(backend.baseUrl);
  const work = freshDir();
  const { code, stdout } = await runCli(['Create hello.py and run it'], { cwd: work });
  assert.equal(code, 0, 'one-shot run completes successfully');
  // The agent loop exercised the real write_file tool → file exists.
  assert.ok(existsSync(join(work, 'hello.py')), 'agent wrote hello.py');
  assert.match(stdout, /Files changed/);
  assert.match(stdout, /\+ hello\.py/);
  assert.match(stdout, /iteration/);
  assert.match(stdout, /one-shot run/);
});

// ---- Interactive mode: startup --------------------------------------------

test('interactive: starts with the banner and exits on EOF', async () => {
  clearSessionFile();
  const { code, stdout } = await runCli([]);
  assert.equal(code, 0, 'exits cleanly on EOF');
  assert.match(stdout, /GRACE/);
  assert.ok(stdout.includes('Enter a coding task or / for commands'), 'shows the prompt hint');
  assert.match(stdout, /Goodbye/);
  assert.match(stdout, /Directory/);
  assert.match(stdout, /not configured/);
  assert.match(stdout, /not logged in/);
});

// ---- Interactive mode: slash commands --------------------------------------

test('interactive: /help and /exit work', async () => {
  const { code, stdout } = await runCli([], { stdin: '/help\n/exit\n' });
  assert.equal(code, 0);
  assert.match(stdout, /\/help\s+Show this help/);
  assert.match(stdout, /\/exit/);
  assert.match(stdout, /Goodbye/);
});

test('interactive: /status works without a provider', async () => {
  clearSessionFile();
  const { code, stdout } = await runCli([], { stdin: '/status\n/exit\n' });
  assert.equal(code, 0);
  assert.match(stdout, /Directory/);
  assert.match(stdout, /not configured/);
  assert.match(stdout, /Goodbye/);
});

// ---- Interactive mode: full E2E flow --------------------------------------

test('interactive: full task flow with mock backend returns to the prompt', async () => {
  const backend = await startBackend('happy');
  writeSession(backend.baseUrl);
  const work = freshDir();
  const { code, stdout } = await runCli([], {
    cwd: work,
    stdin: 'Create hello.py and run it\n/status\n/exit\n',
  });
  assert.equal(code, 0, 'interactive session exits cleanly');
  // The agent loop created the file.
  assert.ok(existsSync(join(work, 'hello.py')), 'agent wrote hello.py via the existing tool loop');
  assert.match(stdout, /Files changed/);
  assert.match(stdout, /\+ hello\.py/);
  // The summary line includes elapsed time.
  assert.match(stdout, /iteration\(s\)/);
  // /status ran after the task → output contains project info.
  assert.match(stdout, /Not a git repository/);
  // The /status output appears after the task summary, proving we returned to
  // the prompt.
  const summaryIdx = stdout.indexOf('Files changed');
  const statusIdx = stdout.indexOf('Not a git repository');
  assert.ok(summaryIdx !== -1 && statusIdx > summaryIdx, 'session continued after the task');
  assert.match(stdout, /Goodbye/);
});

// ---- Interactive mode: error isolation -------------------------------------

test('interactive: a failing task returns to the prompt', async () => {
  const backend = await startBackend('fail');
  writeSession(backend.baseUrl);
  const { code, stdout } = await runCli([], {
    stdin: 'Break everything\n/exit\n',
  });
  assert.equal(code, 0, 'session survives the error and exits cleanly');
  // The error message from the provider should be surfaced.
  assert.match(stdout, /server boom/);
  // The session continued and the exit command was processed.
  assert.match(stdout, /Goodbye/);
});

// ---- Exit behavior ---------------------------------------------------------

test('exit: /exit works', async () => {
  const { code, stdout } = await runCli([], { stdin: '/exit\n' });
  assert.equal(code, 0);
  assert.match(stdout, /Goodbye/);
});

test('exit: /quit works', async () => {
  const { code, stdout } = await runCli([], { stdin: '/quit\n' });
  assert.equal(code, 0);
  assert.match(stdout, /Goodbye/);
});

test('exit: EOF (Ctrl+D equivalent) exits cleanly', async () => {
  const { code, stdout } = await runCli([]);
  assert.equal(code, 0);
  assert.match(stdout, /Goodbye/);
});