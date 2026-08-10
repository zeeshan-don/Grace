/**
 * CLI E2E for the subagent coordinator (Milestone 14).
 *
 * With the scripted mock backend the LLM planner cannot produce a parseable
 * plan, so the deterministic fallback plan runs — exercising the full
 * coordinator lifecycle (scout → picker → editor → test-runner + reviewer)
 * against the real CLI entry point. These tests assert the new concise
 * progress UX (agent labels, arrows, final summary) and that the existing
 * one-shot/interactive flows still work.
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

const ENTRY = join(process.cwd(), 'src', 'index.ts');
const home = mkdtempSync(join(tmpdir(), 'zeesh-coord-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'zeesh-coord-workspace-'));
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

const ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HOME: home,
  USERPROFILE: home,
  NO_COLOR: '1',
  GROQ_API_KEY: '',
};

function freshDir(): string {
  return mkdtempSync(join(workspace, 'work-'));
}

const running: Server[] = [];
afterEach(() => {
  for (const s of running.splice(0)) s.close();
});

/** Mock backend: scripted 2-turn agent (write_file then completion) per agent. */
function startBackend(): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: Array<{ role: string }> }) : {};
      if (req.url === '/api/provider' && req.method === 'POST') {
        const hasToolResult = (body.messages ?? []).some((m) => m.role === 'tool');
        if (!hasToolResult) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            content: null,
            tool_calls: [{ id: 'call_1', name: 'write_file', arguments: JSON.stringify({ path: 'hello.py', content: "print('hello')\n" }) }],
            finish_reason: 'tool_calls',
          }));
        } else {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ content: 'Created hello.py.', tool_calls: [], finish_reason: 'stop' }));
        }
        return;
      }
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
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

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

interface RunResult {
  code: number;
  stdout: string;
}

function runCli(args: string[], opts: { cwd?: string; stdin?: string; timeout?: number } = {}): Promise<RunResult> {
  const { cwd: dir = freshDir(), stdin, timeout = 25_000 } = opts;
  return new Promise((resolve) => {
    const child = spawn('node', [ENTRY, ...args], { env: ENV, cwd: dir });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, stdout: stdout + '\n[timeout]' });
    }, timeout);
    child.stdout.on('data', (d: Buffer) => (stdout += String(d)));
    child.stderr.on('data', () => undefined);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: 1, stdout });
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

test('one-shot: coordinator progress lines appear and the task completes', async () => {
  const baseUrl = await startBackend();
  writeSession(baseUrl);
  const work = freshDir();
  const { code, stdout } = await runCli(['Create hello.py and run it'], { cwd: work });

  assert.equal(code, 0);
  assert.ok(existsSync(join(work, 'hello.py')), 'file written through the coordinator flow');
  // Progress UX: agent labels with arrows, no raw chain-of-thought.
  assert.match(stdout, /→ Project Scout/);
  assert.match(stdout, /→ File Picker/);
  assert.match(stdout, /→ Editor/);
  assert.match(stdout, /→ Test Runner/);
  assert.match(stdout, /✓/);
  // Existing surface preserved.
  assert.match(stdout, /one-shot run/);
  assert.match(stdout, /Changed files: hello\.py/);
  assert.match(stdout, /iteration\(s\)/);
});

test('interactive: coordinator runs a task then returns to the prompt', async () => {
  const baseUrl = await startBackend();
  writeSession(baseUrl);
  const work = freshDir();
  const { code, stdout } = await runCli([], {
    cwd: work,
    stdin: 'Create hello.py and run it\n/status\n/exit\n',
  });

  assert.equal(code, 0);
  assert.ok(existsSync(join(work, 'hello.py')), 'interactive task wrote the file');
  assert.match(stdout, /→ Editor/);
  assert.match(stdout, /Changed files: hello\.py/);
  assert.match(stdout, /Not a git repository/, '/status ran after the task');
  const summaryIdx = stdout.indexOf('Changed files: hello.py');
  const statusIdx = stdout.indexOf('Not a git repository');
  assert.ok(summaryIdx !== -1 && statusIdx > summaryIdx, 'task completed before /status');
  assert.match(stdout, /Goodbye/);
});

test('one-shot: no provider still errors cleanly (coordinator never starts)', async () => {
  clearSession(join(home, '.zeesh', 'auth.json'));
  const { code, stdout } = await runCli(['Fix the login bug']);
  assert.equal(code, 1);
  assert.match(stdout, /No AI provider configured/);
});
