import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { capabilitiesAreReadOnly, commandPolicyForRole, toolsForCapabilities } from '../src/agents/capabilities.ts';
import { compactResults, compactText, renderResult } from '../src/agents/compact.ts';
import { extractLastJsonObject, parseStructuredResult } from '../src/agents/structured.ts';
import { MemorySession } from '../src/session/memory.ts';
import { createRunCommandTool, matchesPrefix } from '../src/tools/runCommand.ts';
import { createTools, type Tool } from '../src/tools/registry.ts';
import type { SubagentResult } from '../src/agents/types.ts';

const ALL_TOOLS = createTools({ projectRoot: process.cwd(), askPermission: async () => false });

function names(tools: Tool[]): string[] {
  return tools.map((t) => t.name);
}

test('capabilities: read-only grant has no write or execute tools', () => {
  const tools = toolsForCapabilities(ALL_TOOLS, ['read']);
  const n = names(tools);
  assert.deepEqual(n.sort(), ['list_directory', 'read_file', 'search_files'].sort());
  assert.ok(!n.includes('write_file'));
  assert.ok(!n.includes('edit_file'));
  assert.ok(!n.includes('run_command'));
  assert.ok(capabilitiesAreReadOnly(['read']));
});

test('capabilities: write/execute/diff/web grants map to the right tools', () => {
  const n = names(toolsForCapabilities(ALL_TOOLS, ['write', 'execute', 'diff', 'web']));
  assert.ok(n.includes('write_file'));
  assert.ok(n.includes('edit_file'));
  assert.ok(n.includes('run_command'));
  assert.ok(n.includes('git_diff'));
  assert.ok(n.includes('web_fetch'));
  assert.ok(!capabilitiesAreReadOnly(['read', 'execute']));
  assert.ok(!capabilitiesAreReadOnly(['write']));
});

test('permissions: a read-only agent physically cannot modify files (unknown tool)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zeesh-readonly-'));
  try {
    const tools = toolsForCapabilities(ALL_TOOLS, ['read']);
    const picked = tools.find((t) => t.name === 'write_file');
    assert.equal(picked, undefined, 'write_file must not be in a read-only grant');
    // Even if the model emitted a write_file call, the loop has no such tool.
    const res = await tools.find((t) => t.name === 'read_file')!.execute({ path: 'nope.txt' }, { projectRoot: root, askPermission: async () => true });
    assert.ok(typeof res === 'string');
    assert.ok(!existsSync(join(root, 'nope.txt')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('command policy: allowPrefixes auto-approve and never partial-match', () => {
  assert.ok(matchesPrefix('npm test', ['npm test']));
  assert.ok(matchesPrefix('npm test -- --runInBand', ['npm test']));
  assert.ok(matchesPrefix('git add src/x.ts', ['git add']));
  assert.ok(!matchesPrefix('npm tests', ['npm test']), 'must not match a longer word');
  assert.ok(!matchesPrefix('git adds', ['git add']));
  assert.ok(!matchesPrefix('echo hi', ['npm test']));
  assert.ok(!matchesPrefix('npm test', undefined));
});

test('command policy: test-runner runs npm test without asking, flags others to the user', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zeesh-policy-'));
  const asked: string[] = [];
  const tool = createRunCommandTool({
    projectRoot: root,
    askPermission: async (cmd) => {
      asked.push(cmd);
      return false;
    },
    commandPolicy: commandPolicyForRole('test-runner'),
  });
  try {
    // Auto-approved prefix: the permission hook is never consulted.
    const res = await tool.execute({ command: 'echo approved' }, { projectRoot: root, askPermission: async () => false });
    assert.ok(!asked.includes('echo approved'), 'allow-prefix command must not ask');
    assert.ok(!res.includes('Command blocked'));
    // Not in the allowlist → goes to the user (and is denied here).
    const blocked = await tool.execute({ command: 'rm -rf sub' }, { projectRoot: root, askPermission: async (c) => (asked.push(c), false) });
    assert.ok(blocked.includes('Command blocked'));
    assert.ok(asked.some((c) => c.includes('rm -rf')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('command policy: git-curator requires approval for staging even though git add is not dangerous', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zeesh-gitpol-'));
  const asked: string[] = [];
  const tool = createRunCommandTool({
    projectRoot: root,
    askPermission: async (cmd) => {
      asked.push(cmd);
      return false;
    },
    commandPolicy: commandPolicyForRole('git-curator'),
  });
  try {
    const res = await tool.execute({ command: 'git add .' }, { projectRoot: root, askPermission: async (c) => (asked.push(c), false) });
    assert.ok(res.includes('Command blocked'), 'git add must require approval for the curator');
    assert.ok(asked.includes('git add .'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('structured result: parses a trailing JSON block from prose', () => {
  const text = 'I found the files.\n\n{"summary": "Found it", "files": ["a.ts", "b.ts"], "findings": ["x depends on y"], "recommendations": ["use edit_file"]}';
  const parsed = parseStructuredResult(text);
  assert.ok(parsed);
  assert.equal(parsed!.summary, 'Found it');
  assert.deepEqual(parsed!.files, ['a.ts', 'b.ts']);
  assert.deepEqual(parsed!.findings, ['x depends on y']);
});

test('structured result: returns null for prose without a result block', () => {
  assert.equal(parseStructuredResult('Just a plain answer, nothing structured.'), null);
  assert.equal(parseStructuredResult(''), null);
  assert.equal(parseStructuredResult('{"no":"recognized fields"}'), null);
});

test('structured result: extracts the last balanced JSON object', () => {
  const text = 'prefix { "a": { "b": 1 } } suffix {"summary":"last"}';
  assert.equal(extractLastJsonObject(text), '{"summary":"last"}');
  assert.equal(extractLastJsonObject('no braces here'), null);
});

function result(over: Partial<SubagentResult>): SubagentResult {
  return {
    agent: 'file-picker',
    label: 'File Picker',
    status: 'completed',
    summary: 's',
    files: [],
    changedFiles: [],
    findings: [],
    recommendations: [],
    iterations: 1,
    toolCalls: 0,
    ...over,
  };
}

test('context compaction: truncates summaries and drops oldest results under budget', () => {
  const long = 'x'.repeat(4_000);
  const r1 = result({ summary: long });
  const r2 = result({ label: 'Editor', agent: 'editor', summary: 'the important final answer' });
  const out = compactResults([r1, r2], 300);
  assert.ok(out.includes('the important final answer'), 'newest result survives');
  assert.ok(out.includes('…'), 'long text truncated');
  assert.ok(out.length < 4_000, 'output stays small');
});

test('context compaction: skips skipped results and renders files/findings', () => {
  const r = result({
    summary: 'three files',
    files: ['a.ts', 'b.ts', 'c.ts'],
    findings: ['f1', 'f2', 'f3'],
    recommendations: ['r1'],
  });
  const skipped = result({ status: 'skipped', summary: 'should not appear' });
  const out = compactResults([skipped, r], 2_000);
  assert.ok(out.includes('three files'));
  assert.ok(out.includes('a.ts'));
  assert.ok(out.includes('f1'));
  assert.ok(!out.includes('should not appear'));
  assert.ok(renderResult(r, 600).includes('[File Picker]'));
});

test('context compaction: compactText keeps head and tail', () => {
  const text = 'A'.repeat(2_000);
  const out = compactText(text, 500);
  assert.ok(out.startsWith('A'));
  assert.ok(out.endsWith('A'));
  assert.ok(out.includes('truncated'));
});

test('memory session: never touches disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'zeesh-memsess-'));
  const mem = new MemorySession();
  mem.pushMessage({ role: 'user', content: 'hi' });
  mem.beginRun();
  mem.addUsage(100, 50);
  mem.recordToolCall('read_file');
  mem.save();
  assert.equal(mem.messageCount, 1);
  assert.equal(mem.stats.toolCalls, 1);
  assert.equal(mem.stats.inputTokens, 100);
  assert.ok(!existsSync(join(root, '.zeesh', 'session.json')), 'no session file written');
  rmSync(root, { recursive: true, force: true });
});
