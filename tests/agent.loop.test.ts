import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentLoop } from '../src/agent/loop.ts';
import { detectProject } from '../src/project/detect.ts';
import { Session } from '../src/session/session.ts';
import { UndoStore } from '../src/session/undo.ts';
import { createTools, type Tool } from '../src/tools/registry.ts';
import { FakeProvider, type ScriptedTurn } from './helpers/fakeProvider.ts';

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'zeesh-loop-'));
}

function setup(root: string, askPermission: (c: string, r: string[]) => Promise<boolean> = async () => false) {
  const project = detectProject(root);
  const session = new Session(root);
  const undo = new UndoStore(root);
  const tools: Tool[] = createTools({ projectRoot: root, askPermission, undo });
  return { project, session, undo, tools };
}

test('agent loop reads a file, edits it, and reports what changed', async () => {
  const root = tempProject();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'calc.js'),
    '// calculator\nexport const add = (a, b) => a - b; // BUG: should be +\n',
  );

  const script: ScriptedTurn[] = [
    { content: null, toolCalls: [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'src/calc.js' }) }] },
    {
      content: null,
      toolCalls: [
        { id: 'c2', name: 'edit_file', arguments: JSON.stringify({ path: 'src/calc.js', edits: [{ oldString: 'a - b', newString: 'a + b' }] }) },
      ],
    },
    { content: 'Fixed the add function: it now returns a + b. Verified by reading the file first.', toolCalls: [] },
  ];

  const { project, session, undo, tools } = setup(root);
  const provider = new FakeProvider(script);
  const statuses: string[] = [];
  let streamedText = '';

  const loop = new AgentLoop({
    provider,
    tools,
    projectRoot: root,
    project,
    session,
    undo,
    onStatus: (m) => statuses.push(m),
    onStream: (t) => (streamedText += t),
    askPermission: async () => false,
  });

  const result = await loop.run('The add function subtracts instead of adding. Fix it.');

  // The real file on disk changed
  const content = readFileSync(join(root, 'src', 'calc.js'), 'utf8');
  assert.ok(content.includes('a + b'), 'file should have been fixed on disk');
  assert.ok(!content.includes('a - b'), 'bug should be gone');

  // Loop reporting
  assert.equal(result.iterations, 3);
  assert.equal(result.toolCalls, 2);
  assert.deepEqual(result.changedFiles, ['src/calc.js']);
  assert.equal(result.finalText, 'Fixed the add function: it now returns a + b. Verified by reading the file first.');
  assert.equal(result.usage?.totalTokens, 450); // 3 turns × 150
  assert.equal(streamedText, result.finalText, 'final answer should have been streamed');
  assert.ok(statuses.some((s) => s.includes('read_file')));
  assert.ok(statuses.some((s) => s.includes('edit_file')));

  // Session persisted
  assert.ok(existsSync(join(root, '.zeesh', 'session.json')));
  assert.equal(session.stats.toolCalls, 2);
  assert.equal(session.stats.inputTokens, 300);

  // Undo restores the original
  const undoResult = undo.undo();
  assert.ok(undoResult);
  assert.equal(undoResult?.file, join(root, 'src', 'calc.js'));
  assert.ok(readFileSync(join(root, 'src', 'calc.js'), 'utf8').includes('a - b'), 'undo should restore the buggy version');
});

test('run_command is blocked when the user denies permission', async () => {
  const root = tempProject();
  mkdirSync(join(root, 'sub'), { recursive: true });
  const denied: string[] = [];
  const { project, session, undo, tools } = setup(root, async (cmd, reasons) => {
    denied.push(cmd);
    return false;
  });

  const script: ScriptedTurn[] = [
    {
      content: null,
      toolCalls: [{ id: 'c1', name: 'run_command', arguments: JSON.stringify({ command: 'rm -rf sub' }) }],
    },
    { content: 'OK, I will not delete anything.', toolCalls: [] },
  ];

  const loop = new AgentLoop({
    provider: new FakeProvider(script),
    tools,
    projectRoot: root,
    project,
    session,
    undo,
    askPermission: async (cmd, reasons) => {
      denied.push(cmd);
      return false;
    },
  });
  const result = await loop.run('Delete the sub directory');
  assert.equal(denied.length, 1);
  assert.ok(denied[0]?.includes('rm -rf'));
  assert.ok(result.finalText.includes('will not delete'));
  // The sub dir still exists (nothing was deleted)
  assert.ok(existsSync(join(root, 'sub')));
});

test('run_command runs when the user approves', async () => {
  const root = tempProject();
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'sub', 'x.txt'), 'hi');

  const { project, session, undo, tools } = setup(root, async () => true);
  const command = process.platform === 'win32' ? 'rmdir /s /q sub' : 'rm -rf sub';

  const script: ScriptedTurn[] = [
    { content: null, toolCalls: [{ id: 'c1', name: 'run_command', arguments: JSON.stringify({ command }) }] },
    { content: 'Deleted.', toolCalls: [] },
  ];

  const loop = new AgentLoop({
    provider: new FakeProvider(script),
    tools,
    projectRoot: root,
    project,
    session,
    undo,
    askPermission: async () => true,
  });
  await loop.run('Delete the sub directory');
  assert.ok(!existsSync(join(root, 'sub', 'x.txt')), 'approved command should have executed');
});

test('agent loop recovers from a bad tool name with an error result', async () => {
  const root = tempProject();
  const { project, session, undo, tools } = setup(root);
  const script: ScriptedTurn[] = [
    { content: null, toolCalls: [{ id: 'c1', name: 'no_such_tool', arguments: '{}' }] },
    { content: 'Right, that tool does not exist.', toolCalls: [] },
  ];
  const loop = new AgentLoop({
    provider: new FakeProvider(script),
    tools,
    projectRoot: root,
    project,
    session,
    undo,
    askPermission: async () => false,
  });
  const result = await loop.run('do the thing');
  assert.equal(result.finalText, 'Right, that tool does not exist.');
  assert.ok(session.toolHistory.some((h) => h.includes('no_such_tool')));
});

test('agent loop surfaces a rate-limited turn immediately — the Model Router handles fallback, not the client', async () => {
  const root = tempProject();
  const { project, session, undo, tools } = setup(root);
  // The provider chain (server-side FallbackProvider) already tried every
  // provider inside this ONE request; a client-side backoff retry would only
  // re-hit the same exhausted providers. The failure must surface once.
  const script: ScriptedTurn[] = [{ error: '429 rate limit hit' }];
  const provider = new FakeProvider(script);
  const loop = new AgentLoop({
    provider,
    tools,
    projectRoot: root,
    project,
    session,
    undo,
    askPermission: async () => false,
  });
  const result = await loop.run('hi');
  assert.equal(provider.callCount, 1, 'no client-side retry after a rate limit');
  assert.ok(result.finalText.startsWith('I could not reach the AI provider'), 'the failure is reported');
  assert.match(result.finalText, /rate limit/i, 'the user sees a clean rate-limit hint');
});

test('agent loop never re-sends a too-large (TPM/413) request and never leaks raw provider codes', async () => {
  const root = tempProject();
  const { project, session, undo, tools } = setup(root);
  const script: ScriptedTurn[] = [{ error: 'Error 413: TPM limit exceeded, requested 11468 limit 8000' }];
  const provider = new FakeProvider(script);
  const loop = new AgentLoop({
    provider,
    tools,
    projectRoot: root,
    project,
    session,
    undo,
    askPermission: async () => false,
  });
  const result = await loop.run('hi');
  assert.equal(provider.callCount, 1, 'a too-large request is never re-sent');
  assert.ok(result.finalText.startsWith('I could not reach the AI provider'));
  assert.match(result.finalText, /rate limit/i, 'the user sees a clean rate-limit hint');
  assert.ok(!result.finalText.includes('413'), 'raw provider codes never leak to the user');
  assert.ok(!result.finalText.includes('11468'), 'raw provider numbers never leak to the user');
});

test('agent loop stops at the iteration limit', async () => {
  const root = tempProject();
  const { project, session, undo, tools } = setup(root);
  const script: ScriptedTurn[] = Array.from({ length: 10 }, () => ({
    content: null,
    toolCalls: [{ id: 'c', name: 'list_directory', arguments: JSON.stringify({}) }],
  }));
  const loop = new AgentLoop({
    provider: new FakeProvider(script),
    tools,
    projectRoot: root,
    project,
    session,
    undo,
    askPermission: async () => false,
    maxIterations: 2,
  });
  const result = await loop.run('loop forever');
  assert.equal(result.iterations, 2);
  assert.equal(result.reachedLimit, true);
  assert.ok(result.finalText.includes('iteration limit'));
});

// ---------------------------------------------------------------------------
// Tool-call JSON validation (Problem 1) + failure classification (Problem 6)
// ---------------------------------------------------------------------------

test('agent loop handles malformed tool-call arguments safely and never blames the provider', async () => {
  const root = tempProject();
  writeFileSync(join(root, 'a.txt'), 'hello');
  const script: ScriptedTurn[] = [
    { content: null, toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{ bad json' }] },
    { content: 'Understood — I will fix the arguments next time.', toolCalls: [] },
  ];
  const { project, session, undo, tools } = setup(root);
  const loop = new AgentLoop({
    provider: new FakeProvider(script),
    tools,
    projectRoot: root,
    project,
    session,
    undo,
    askPermission: async () => false,
  });
  const result = await loop.run('do the thing');

  // The task recovered and finished — it was NOT reported as a provider failure.
  assert.equal(result.finalText, 'Understood — I will fix the arguments next time.');
  assert.ok(!result.finalText.includes('I could not reach the AI provider'), 'parser failure is not a provider failure');
  assert.equal(result.error, undefined);
  assert.equal(result.failedToolCalls, 1);

  // The model received a tool error explaining the malformed arguments.
  assert.ok(
    session.toolHistory.some((h) => h.includes('invalid JSON arguments')),
    'the malformed call is recorded with a diagnostic',
  );

  // The assistant message pushed to the session must NOT carry malformed JSON
  // to the provider (the original 400 "Failed to parse tool call arguments").
  const assistant = session.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(assistant?.tool_calls?.[0]?.arguments, '{}', 'wire arguments are sanitized');
});

test('agent loop fails with InvalidToolCall after repeated unparseable tool calls (no infinite thrash)', async () => {
  const root = tempProject();
  const script: ScriptedTurn[] = [
    { content: null, toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{ broken' }] },
    { content: null, toolCalls: [{ id: 'c2', name: 'read_file', arguments: '{ broken' }] },
  ];
  const { project, session, undo, tools } = setup(root);
  const loop = new AgentLoop({
    provider: new FakeProvider(script),
    tools,
    projectRoot: root,
    project,
    session,
    undo,
    askPermission: async () => false,
  });
  const result = await loop.run('read the file');

  assert.equal(result.error?.category, 'invalid_tool_call');
  assert.equal(result.error?.providerLabel, 'Fake (test)');
  assert.ok(result.finalText.includes('could not be executed safely'));
  assert.equal(result.reachedLimit, false, 'fails fast — not by hitting the iteration cap');
});

test('agent loop recovers when the provider rejects malformed tool-call arguments', async () => {
  const root = tempProject();
  // The provider itself rejects the model's malformed streamed tool call (the
  // original Groq "Failed to parse tool call arguments as JSON" 400). The loop
  // must not call it a provider outage: it retries and the task continues.
  const script: ScriptedTurn[] = [
    { error: 'Failed to parse tool call arguments as JSON' },
    { error: 'Failed to parse tool call arguments as JSON' },
    { content: 'Recovered after the malformed tool call.', toolCalls: [] },
  ];
  const { project, session, undo, tools } = setup(root);
  const provider = new FakeProvider(script);
  const loop = new AgentLoop({
    provider,
    tools,
    projectRoot: root,
    project,
    session,
    undo,
    askPermission: async () => false,
  });
  const result = await loop.run('do the thing');

  assert.equal(provider.callCount, 3, 'two failed streams + one successful recovery');
  assert.equal(result.finalText, 'Recovered after the malformed tool call.');
  assert.equal(result.error, undefined, 'a recoverable malformed call is not a failure');
  assert.ok(!result.finalText.includes('I could not reach the AI provider'));
});

test('agent loop classifies a persistent provider-rejected tool call as InvalidToolCall, not provider outage', async () => {
  const root = tempProject();
  const script: ScriptedTurn[] = Array.from({ length: 5 }, () => ({ error: 'Failed to parse tool call arguments as JSON' }));
  const { project, session, undo, tools } = setup(root);
  const loop = new AgentLoop({
    provider: new FakeProvider(script),
    tools,
    projectRoot: root,
    project,
    session,
    undo,
    askPermission: async () => false,
  });
  const result = await loop.run('do the thing');

  assert.equal(result.error?.category, 'invalid_tool_call', 'a malformed tool call is not a provider outage');
  assert.ok(!result.finalText.includes('I could not reach the AI provider'), 'parser failure is not blamed on the provider');
  assert.ok(result.finalText.includes('could not be completed'));
});

test('agent loop classifies provider failures (timeout / auth / unavailable)', async () => {
  const root = tempProject();

  const runWithError = async (error: string): Promise<Awaited<ReturnType<AgentLoop['run']>>> => {
    const { project, session, undo, tools } = setup(root);
    const loop = new AgentLoop({
      provider: new FakeProvider([{ error }]),
      tools,
      projectRoot: root,
      project,
      session,
      undo,
      askPermission: async () => false,
    });
    return loop.run('hi');
  };

  const timeout = await runWithError('ETIMEDOUT after 30s');
  assert.equal(timeout.error?.category, 'provider_timeout');
  assert.ok(timeout.finalText.startsWith('I could not reach the AI provider'));

  const auth = await runWithError('401 Unauthorized: invalid api key');
  assert.equal(auth.error?.category, 'provider_authentication');

  const generic = await runWithError('server boom');
  assert.equal(generic.error?.category, 'provider_unavailable');
});

// ---------------------------------------------------------------------------
// Tool dedup cache (Problem 2)
// ---------------------------------------------------------------------------

test('agent loop dedupes repeated identical reads and refreshes after an edit', async () => {
  const root = tempProject();
  writeFileSync(join(root, 'a.txt'), 'v1');
  const script: ScriptedTurn[] = [
    { content: null, toolCalls: [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) }] },
    { content: null, toolCalls: [{ id: 'c2', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) }] },
    {
      content: null,
      toolCalls: [{ id: 'c3', name: 'edit_file', arguments: JSON.stringify({ path: 'a.txt', edits: [{ oldString: 'v1', newString: 'v2' }] }) }],
    },
    { content: null, toolCalls: [{ id: 'c4', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) }] },
    { content: 'done', toolCalls: [] },
  ];
  const { project, session, undo, tools } = setup(root);
  const loop = new AgentLoop({
    provider: new FakeProvider(script),
    tools,
    projectRoot: root,
    project,
    session,
    undo,
    askPermission: async () => false,
  });
  const result = await loop.run('inspect the file');

  assert.equal(result.toolCalls, 4, 'all four calls were made');
  assert.equal(result.duplicateToolCalls, 1, 'the second identical read was served from cache');
  assert.ok(readFileSync(join(root, 'a.txt'), 'utf8').includes('v2'), 'the edit landed');
  assert.ok(result.finalText === 'done');
});

test('agent loop never caches failed tool results', async () => {
  const root = tempProject();
  // The file does not exist → the first read errors; a repeated read must
  // execute again (no stale error replay), so duplicateToolCalls stays 0.
  const script: ScriptedTurn[] = [
    { content: null, toolCalls: [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'nope.txt' }) }] },
    { content: null, toolCalls: [{ id: 'c2', name: 'read_file', arguments: JSON.stringify({ path: 'nope.txt' }) }] },
    { content: 'no file', toolCalls: [] },
  ];
  const { project, session, undo, tools } = setup(root);
  const loop = new AgentLoop({
    provider: new FakeProvider(script),
    tools,
    projectRoot: root,
    project,
    session,
    undo,
    askPermission: async () => false,
  });
  const result = await loop.run('read it');
  assert.equal(result.duplicateToolCalls, 0, 'error results are never cached');
  assert.equal(result.toolCalls, 2);
});

// ---------------------------------------------------------------------------
// Dependency installation gating (Problem 4)
// ---------------------------------------------------------------------------

test('run_command kills a long-running command instead of hanging the agent', async () => {
  const root = tempProject();
  const { project, session, undo, tools } = setup(root, async () => true);
  // A server-style command that would never return on its own.
  const script: ScriptedTurn[] = [
    {
      content: null,
      toolCalls: [
        {
          id: 'c1',
          name: 'run_command',
          arguments: JSON.stringify({ command: 'node -e "setTimeout(() => {}, 100000)"', timeoutSec: 1 }),
        },
      ],
    },
    { content: 'The command timed out; I will avoid starting long-running processes.', toolCalls: [] },
  ];
  const loop = new AgentLoop({
    provider: new FakeProvider(script),
    tools,
    projectRoot: root,
    project,
    session,
    undo,
    askPermission: async () => true,
  });
  const result = await loop.run('start a server');
  assert.ok(result.finalText.includes('long-running'), 'the model reacted to the timeout');
  // The tool result told the model the command was killed.
  assert.ok(session.toolHistory.some((h) => h.includes('run_command')), 'command was recorded');
});

test('run_command requires approval for dependency installation (pip install)', async () => {
  const root = tempProject();
  const denied: string[] = [];
  const { project, session, undo, tools } = setup(root, async (cmd) => {
    denied.push(cmd);
    return false;
  });
  const script: ScriptedTurn[] = [
    { content: null, toolCalls: [{ id: 'c1', name: 'run_command', arguments: JSON.stringify({ command: 'pip install flask' }) }] },
    { content: 'OK, I will not install anything.', toolCalls: [] },
  ];
  const loop = new AgentLoop({
    provider: new FakeProvider(script),
    tools,
    projectRoot: root,
    project,
    session,
    undo,
    askPermission: async (cmd) => {
      denied.push(cmd);
      return false;
    },
  });
  const result = await loop.run('install flask');
  assert.equal(denied.length, 1, 'the permission prompt was shown');
  assert.ok(denied[0]?.includes('pip install'));
  assert.ok(result.finalText.includes('will not install'));
});
