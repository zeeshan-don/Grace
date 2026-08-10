import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Coordinator } from '../src/agents/coordinator.ts';
import { ruleBasedPlanner } from '../src/agents/planner.ts';
import type { AgentPlan, Planner } from '../src/agents/types.ts';
import { detectProject } from '../src/project/detect.ts';
import type { AIProvider } from '../src/providers/types.ts';
import type { Runtime } from '../src/runtime.ts';
import { Session } from '../src/session/session.ts';
import { UndoStore } from '../src/session/undo.ts';
import { createTools } from '../src/tools/registry.ts';
import { FakeProvider, type ScriptedTurn } from './helpers/fakeProvider.ts';

const tmpRoots: string[] = [];
function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'zeesh-coord-'));
  tmpRoots.push(root);
  return root;
}
afterEach(() => {
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function makeRuntime(root: string, provider: AIProvider | null, ask: (c: string, r: string[]) => Promise<boolean> = async () => false): Runtime {
  const project = detectProject(root);
  const session = new Session(root);
  const undo = new UndoStore(root);
  const tools = createTools({ projectRoot: root, askPermission: ask, undo });
  return { root, project, session, undo, provider, providerError: null, tools, yes: false, ask, model: 'fake-1' };
}

function plan(steps: Array<{ agents: string[]; reason?: string }>): Planner {
  const p: AgentPlan = { steps: steps.map((s) => ({ agents: s.agents as AgentPlan['steps'][number]['agents'], reason: s.reason ?? '' })) };
  return async () => p;
}

const DONE_JSON = '{"summary":"found it","files":["a.ts"],"findings":["f"],"recommendations":["r"]}';

// ---------------------------------------------------------------------------

test('coordinator: minimal-agent selection runs exactly the planned agent', async () => {
  const root = tempProject();
  const provider = new FakeProvider([{ content: DONE_JSON }]);
  const runtime = makeRuntime(root, provider);
  const events: string[] = [];
  const coordinator = new Coordinator({
    runtime,
    planner: plan([{ agents: ['file-picker'] }]),
    onEvent: (e) => events.push(e.type === 'agent-start' ? `start:${e.role}` : e.type),
  });
  const out = await coordinator.run('explain src/auth/session.ts');

  assert.equal(provider.callCount, 1, 'only one model call for one agent');
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0]!.status, 'completed');
  assert.equal(out.results[0]!.summary, 'found it');
  assert.deepEqual(out.results[0]!.files, ['a.ts']);
  assert.ok(events.includes('start:file-picker'));
  assert.ok(out.finalAnswer.includes('found it'));
});

test('coordinator: sequential delegation — step 2 starts only after step 1 finishes', async () => {
  const root = tempProject();
  const provider = new FakeProvider([
    { content: '{"summary":"mapped","files":[]}' },
    { content: '{"summary":"edited","files":["x.ts"]}' },
  ]);
  const runtime = makeRuntime(root, provider);
  const order: string[] = [];
  const coordinator = new Coordinator({
    runtime,
    planner: plan([{ agents: ['project-scout'] }, { agents: ['editor'] }]),
    onEvent: (e) => {
      if (e.type === 'agent-start' || e.type === 'agent-done') order.push(`${e.type}:${e.role}`);
    },
  });
  await coordinator.run('fix the bug');
  const starts = order.filter((o) => o.startsWith('agent-start')).map((o) => o.replace('agent-start:', ''));
  assert.deepEqual(starts, ['project-scout', 'editor']);
  const scoutDone = order.indexOf('agent-done:project-scout');
  const editorStart = order.indexOf('agent-start:editor');
  assert.ok(scoutDone !== -1 && editorStart > scoutDone, 'editor must wait for the scout');
});

test('coordinator: parallel delegation — independent agents overlap in time', async () => {
  const root = tempProject();
  const provider = new FakeProvider([
    { content: '{"summary":"ran tests","files":[]}', delayMs: 60 },
    { content: '{"summary":"reviewed","files":[]}', delayMs: 60 },
  ]);
  const runtime = makeRuntime(root, provider);
  const order: string[] = [];
  const coordinator = new Coordinator({
    runtime,
    planner: plan([{ agents: ['test-runner', 'code-reviewer'], reason: 'parallel step' }]),
    onEvent: (e) => {
      if (e.type === 'agent-start' || e.type === 'agent-done') order.push(`${e.type}:${e.role}`);
    },
  });
  await coordinator.run('verify the change');

  // Deterministic overlap proof: if the step were serialized, each agent would
  // finish before the next one starts. Both starts before either done proves
  // the two agents ran concurrently.
  const firstDone = order.findIndex((o) => o.startsWith('agent-done'));
  assert.ok(firstDone > order.indexOf('agent-start:test-runner'), 'test-runner started before the first agent finished');
  assert.ok(firstDone > order.indexOf('agent-start:code-reviewer'), 'code-reviewer started before the first agent finished');
});

test('coordinator: failed-agent recovery — a failing explorer does not abort the run', async () => {
  const root = tempProject();
  const provider = new FakeProvider([
    { error: 'server boom' }, // file-picker fails
    { content: '{"summary":"implemented the fix","files":["x.ts"],"recommendations":["done"]}' }, // editor succeeds
  ]);
  const runtime = makeRuntime(root, provider);
  const coordinator = new Coordinator({ runtime, planner: plan([{ agents: ['file-picker'] }, { agents: ['editor'] }]) });
  const out = await coordinator.run('fix the bug');

  assert.equal(out.results[0]!.status, 'failed');
  assert.match(out.results[0]!.error ?? '', /server boom/);
  assert.equal(out.results[1]!.status, 'completed');
  assert.ok(out.finalAnswer.includes('implemented the fix'), 'final answer comes from the surviving agent');
});

test('coordinator: editor modifications reach the disk and are reported', async () => {
  const root = tempProject();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'calc.js'), '// calc\nexport const add = (a, b) => a - b; // BUG\n');
  const script: ScriptedTurn[] = [
    { content: null, toolCalls: [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'src/calc.js' }) }] },
    {
      content: null,
      toolCalls: [{ id: 'c2', name: 'edit_file', arguments: JSON.stringify({ path: 'src/calc.js', edits: [{ oldString: 'a - b', newString: 'a + b' }] }) }],
    },
    { content: 'Fixed the add function.' },
  ];
  const runtime = makeRuntime(root, new FakeProvider(script));
  const coordinator = new Coordinator({ runtime, planner: plan([{ agents: ['editor'] }]) });
  const out = await coordinator.run('fix the add function');

  assert.ok(readFileSync(join(root, 'src', 'calc.js'), 'utf8').includes('a + b'), 'file changed on disk');
  assert.ok(out.changedFiles.includes('src/calc.js'));
  assert.equal(out.results[0]!.status, 'completed');
  assert.ok(out.finalAnswer.includes('Fixed the add function.'));
});

test('coordinator: read-only agent cannot write even when the model tries', async () => {
  const root = tempProject();
  // The picker model (wrongly) attempts write_file — the coordinator grants no
  // such tool, the loop reports an unknown-tool error, and no file appears.
  const script: ScriptedTurn[] = [
    { content: null, toolCalls: [{ id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'evil.ts', content: 'x' }) }] },
    { content: '{"summary":"done","files":[]}' },
  ];
  const runtime = makeRuntime(root, new FakeProvider(script));
  const coordinator = new Coordinator({ runtime, planner: plan([{ agents: ['file-picker'] }]) });
  const out = await coordinator.run('pick files');
  assert.ok(out.results[0]!.status === 'completed' || out.results[0]!.status === 'failed');
  // The write never reached disk — the read-only grant simply has no such tool.
  assert.ok(!importExists(join(root, 'evil.ts')), 'no write happened on disk');
});

function importExists(p: string): boolean {
  try {
    readFileSync(p, 'utf8');
    return true;
  } catch {
    return false;
  }
}

test('coordinator: browser-use is reported unavailable, never silently no-op', async () => {
  const root = tempProject();
  const provider = new FakeProvider();
  const runtime = makeRuntime(root, provider);
  const coordinator = new Coordinator({ runtime, planner: plan([{ agents: ['browser-use'] }]) });
  const out = await coordinator.run('why does this website look broken');

  assert.equal(out.results[0]!.status, 'unavailable');
  assert.equal(provider.callCount, 0, 'no model call for an unavailable agent');
  assert.match(out.finalAnswer, /unavailable/i);
});

test('coordinator: aggregates usage, iterations and changed files across agents', async () => {
  const root = tempProject();
  const provider = new FakeProvider([
    { content: '{"summary":"picked","files":["a.ts"]}' },
    { content: '{"summary":"implemented","files":["a.ts"]}' },
  ]);
  const runtime = makeRuntime(root, provider);
  const coordinator = new Coordinator({ runtime, planner: plan([{ agents: ['file-picker'] }, { agents: ['editor'] }]) });
  const out = await coordinator.run('do the thing');
  assert.equal(out.results.length, 2);
  assert.equal(out.usage?.totalTokens, 300, '2 agents × 150 tokens');
  assert.equal(out.iterations, 2);
});

test('coordinator: per-agent crash recovery — an unexpected throw does not abort the run', async () => {
  const root = tempProject();
  const provider = new FakeProvider([{ content: DONE_JSON }]);
  const runtime = makeRuntime(root, provider);
  let factoryCalls = 0;
  const coordinator = new Coordinator({
    runtime,
    planner: plan([{ agents: ['file-picker'] }, { agents: ['file-picker'] }]),
    providerFactory: (role) => {
      factoryCalls += 1;
      if (factoryCalls === 1) throw new Error('factory boom');
      return role === 'file-picker' ? provider : null;
    },
  });
  const out = await coordinator.run('do the thing');
  assert.equal(out.results[0]!.status, 'failed');
  assert.match(out.results[0]!.error ?? '', /factory boom/);
  assert.equal(out.results[1]!.status, 'completed', 'second agent still ran after the first crashed');
});

test('coordinator: bounded review→fix loop re-runs the editor and re-verifies once', async () => {
  const root = tempProject();
  // The test runner is deterministic (NO_LLM) — only the editor and reviewer
  // consume model requests.
  const provider = new FakeProvider([
    { content: '{"summary":"implemented v1","files":[]}' },
    { content: '{"summary":"reviewed","files":[],"recommendations":["fix X"]}' },
    { content: '{"summary":"implemented v2, fixed X","files":[]}' },
  ]);
  const runtime = makeRuntime(root, provider);
  const coordinator = new Coordinator({
    runtime,
    planner: plan([
      { agents: ['editor'] },
      { agents: ['test-runner', 'code-reviewer'], reason: 'verify in parallel' },
    ]),
  });
  const out = await coordinator.run('implement the feature');

  assert.equal(provider.callCount, 3, 'editor(1) + reviewer(1) + fix editor(1); test-runner is deterministic');
  const editors = out.results.filter((r) => r.agent === 'editor');
  assert.equal(editors.length, 2, 'one fix pass after the review');
  const testerRuns = out.results.filter((r) => r.agent === 'test-runner');
  assert.equal(testerRuns.length, 2, 'test-runner verified both before and after the fix (no LLM)');
  assert.ok(testerRuns.every((r) => r.status === 'skipped'), 'bare temp dir: no test framework, nothing run');
  assert.ok(out.finalAnswer.includes('implemented v2'), 'the fixed run supersedes the first attempt');
});

test('coordinator: test-runner executes tests deterministically without an LLM', async () => {
  const root = tempProject();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test test.js' } }));
  writeFileSync(join(root, 'test.js'), "const { test } = require('node:test');\ntest('ok', () => {});\n");
  const provider = new FakeProvider(); // no script — no model call may happen
  const runtime = makeRuntime(root, provider);
  const coordinator = new Coordinator({ runtime, planner: plan([{ agents: ['test-runner'] }]) });
  const out = await coordinator.run('run the tests');

  assert.equal(provider.callCount, 0, 'the deterministic test runner never calls the model');
  const tester = out.results.find((r) => r.agent === 'test-runner');
  assert.ok(tester, 'a test-runner result exists');
  assert.equal(tester!.status, 'completed', 'the real test command ran and passed');
  assert.equal(tester!.iterations, 0);
  assert.equal(tester!.toolCalls, 0);
});

test('coordinator: test-runner without a test framework reports skipped, no LLM', async () => {
  const root = tempProject(); // empty dir — no framework detected
  const provider = new FakeProvider();
  const runtime = makeRuntime(root, provider);
  const coordinator = new Coordinator({ runtime, planner: plan([{ agents: ['test-runner'] }]) });
  const out = await coordinator.run('run the tests');

  assert.equal(provider.callCount, 0, 'no model request for a framework-less test run');
  assert.equal(out.results[0]?.status, 'skipped');
  assert.match(out.results[0]?.summary ?? '', /No test framework detected/);
});

test('coordinator: no fix loop when the reviewer has nothing to fix', async () => {
  const root = tempProject();
  const provider = new FakeProvider([
    { content: '{"summary":"implemented","files":[]}' },
    { content: '{"summary":"reviewed, all good","files":[],"findings":["no blockers"]}' },
  ]);
  const runtime = makeRuntime(root, provider);
  const coordinator = new Coordinator({
    runtime,
    planner: plan([{ agents: ['editor'] }, { agents: ['code-reviewer'] }]),
  });
  const out = await coordinator.run('implement');
  assert.equal(provider.callCount, 2, 'no extra editor pass');
  assert.equal(out.results.filter((r) => r.agent === 'editor').length, 1);
});

test('coordinator: events fire planning/start/done/done in order', async () => {
  const root = tempProject();
  const runtime = makeRuntime(root, new FakeProvider([{ content: DONE_JSON }]));
  const seen: string[] = [];
  const coordinator = new Coordinator({
    runtime,
    planner: plan([{ agents: ['file-picker'] }]),
    onEvent: (e) => seen.push(e.type),
  });
  await coordinator.run('task');
  assert.deepEqual(seen, ['planning', 'step-start', 'agent-start', 'agent-done', 'done']);
});

// ---------------------------------------------------------------------------
// Rule-based planner routing
// ---------------------------------------------------------------------------

function fallbackPlan(task: string): AgentPlan {
  return ruleBasedPlanner({ task, indexSummary: 'index', availableAgents: ['project-scout', 'file-picker', 'thinker', 'researcher', 'code-reviewer', 'test-runner', 'shell-runner', 'git-curator', 'browser-use', 'editor'], unavailableAgents: [] });
}

test('planner routing: "run the tests" → test-runner only', () => {
  const p = fallbackPlan('run the tests');
  assert.deepEqual(p.steps.map((s) => s.agents), [['test-runner']]);
});

test('planner routing: "commit my changes" → git-curator', () => {
  const p = fallbackPlan('commit my changes');
  assert.deepEqual(p.steps.map((s) => s.agents), [['git-curator']]);
});

test('planner routing: "explain src/auth/session.ts" → file-picker only', () => {
  const p = fallbackPlan('explain src/auth/session.ts');
  assert.deepEqual(p.steps.map((s) => s.agents), [['file-picker']]);
});

test('planner routing: "where is authentication implemented" → scout then picker', () => {
  const p = fallbackPlan('where is authentication implemented');
  assert.deepEqual(p.steps.map((s) => s.agents), [['project-scout'], ['file-picker']]);
});

test('planner routing: coding task follows scout → picker → editor → verify lifecycle', () => {
  const p = fallbackPlan('fix the login bug');
  const agents = p.steps.map((s) => s.agents);
  assert.deepEqual(agents[0], ['project-scout']);
  assert.deepEqual(agents[1], ['file-picker']);
  assert.deepEqual(agents[2], ['editor']);
  assert.deepEqual(agents[3]?.sort(), ['code-reviewer', 'test-runner']);
});

test('planner routing: complex task inserts a thinker', () => {
  const p = fallbackPlan('refactor the authentication architecture');
  const all = p.steps.flatMap((s) => s.agents);
  assert.ok(all.includes('thinker'));
});

test('planner routing: research task uses researcher + thinker', () => {
  const p = fallbackPlan('research how to integrate stripe');
  assert.deepEqual(p.steps.map((s) => s.agents), [['researcher'], ['thinker']]);
});

test('planner routing: browser task plans browser-use', () => {
  const p = fallbackPlan('why does this website look broken');
  const all = p.steps.flatMap((s) => s.agents);
  assert.ok(all.includes('browser-use'));
});
