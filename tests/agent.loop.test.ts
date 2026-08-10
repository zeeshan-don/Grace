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
