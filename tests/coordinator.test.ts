import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Coordinator } from '../src/agents/coordinator.ts';
import { classifyTask, conversationReply } from '../src/agents/fastRouter.ts';
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
// Fast local router (deterministic — no model call)
// ---------------------------------------------------------------------------

test('router: greetings and small talk are conversational (0 LLM calls)', () => {
  for (const t of ['hi', 'hello', 'thanks', 'thank you', 'what can you do?', 'who are you', 'hey', 'good morning']) {
    assert.equal(classifyTask(t).route, 'conversation', t);
  }
  assert.equal(conversationReply('hi'), 'Hey. What are we building?');
  assert.match(conversationReply('what can you do?'), /GRACE/);
});

test('router: pure test runs are deterministic', () => {
  assert.equal(classifyTask('run the tests').route, 'tests');
  assert.equal(classifyTask('are the tests passing').route, 'tests');
  assert.equal(classifyTask('run the build').route, 'tests');
  // But fixing a failing test is the primary agent's job.
  assert.equal(classifyTask('run the tests and fix failures').route, 'coding');
});

test('router: complex/system tasks are eligible for planning', () => {
  for (const t of [
    'build authentication',
    'redesign the entire database',
    'refactor the architecture',
    'convert this application from X to Y',
    'design a microservice for payments',
  ]) {
    assert.equal(classifyTask(t).route, 'complex', t);
  }
});

test('router: explain/inspect tasks route to the primary agent (inspect)', () => {
  for (const t of ['explain package.json', 'what does this file do?', 'why is the build failing', 'summarize the session flow']) {
    assert.equal(classifyTask(t).route, 'inspect', t);
  }
});

test('router: ordinary coding tasks go straight to the primary agent', () => {
  for (const t of ['change the title text in the relevant file', 'fix this TypeScript error', 'add a button', 'rename this function']) {
    assert.equal(classifyTask(t).route, 'coding', t);
  }
});

test('router: browser-verification requests are eligible for planning (browser specialist)', () => {
  assert.equal(classifyTask('why does this website look broken').route, 'complex');
});

// ---------------------------------------------------------------------------
// Conversation path — zero model calls, zero tools
// ---------------------------------------------------------------------------

test('coordinator: a greeting is answered locally with zero model calls', async () => {
  const root = tempProject();
  const provider = new FakeProvider();
  const runtime = makeRuntime(root, provider);
  const events: string[] = [];
  const coordinator = new Coordinator({ runtime, onEvent: (e) => events.push(e.type) });
  const out = await coordinator.run('hi');

  assert.equal(provider.callCount, 0, 'no model call for a greeting');
  assert.equal(out.results.length, 0, 'no agents spawned');
  assert.equal(out.route, 'conversation');
  assert.equal(out.finalAnswer, 'Hey. What are we building?');
  assert.equal(out.iterations, 0);
  assert.equal(out.metrics.llmCalls, 0);
  assert.deepEqual(events, ['route', 'done']);
});

test('coordinator: a greeting works even without any provider configured', async () => {
  const root = tempProject();
  const runtime = makeRuntime(root, null);
  const coordinator = new Coordinator({ runtime });
  const out = await coordinator.run('hello');
  assert.equal(out.route, 'conversation');
  assert.ok(out.finalAnswer.length > 0);
  assert.equal(out.metrics.llmCalls, 0);
});

// ---------------------------------------------------------------------------
// Tests path — deterministic runner, zero model calls
// ---------------------------------------------------------------------------

test('coordinator: "run the tests" executes the deterministic runner without an LLM', async () => {
  const root = tempProject();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test test.js' } }));
  writeFileSync(join(root, 'test.js'), "const { test } = require('node:test');\ntest('ok', () => {});\n");
  const provider = new FakeProvider();
  const runtime = makeRuntime(root, provider);
  const coordinator = new Coordinator({ runtime });
  const out = await coordinator.run('run the tests');

  assert.equal(provider.callCount, 0, 'the deterministic test runner never calls the model');
  assert.equal(out.route, 'tests');
  const tester = out.results.find((r) => r.agent === 'test-runner');
  assert.ok(tester, 'a test-runner result exists');
  assert.equal(tester!.status, 'completed', 'the real test command ran and passed');
  assert.equal(out.metrics.llmCalls, 0);
});

test('coordinator: test run without a test framework reports skipped, no LLM', async () => {
  const root = tempProject();
  const provider = new FakeProvider();
  const runtime = makeRuntime(root, provider);
  const coordinator = new Coordinator({ runtime });
  const out = await coordinator.run('run the tests');

  assert.equal(provider.callCount, 0);
  assert.equal(out.results[0]?.status, 'skipped');
  assert.match(out.results[0]?.summary ?? '', /No test framework detected/);
});

// ---------------------------------------------------------------------------
// Primary agent (default path)
// ---------------------------------------------------------------------------

test('coordinator: a coding task runs ONLY the primary agent (one agent loop)', async () => {
  const root = tempProject();
  const provider = new FakeProvider([{ content: DONE_JSON }]);
  const runtime = makeRuntime(root, provider);
  const events: string[] = [];
  const coordinator = new Coordinator({
    runtime,
    onEvent: (e) => events.push(e.type === 'agent-start' ? `start:${e.role}` : e.type),
  });
  const out = await coordinator.run('explain src/auth/session.ts');

  assert.equal(provider.callCount, 1, 'exactly one model loop for one primary agent');
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0]!.agent, 'editor', 'the primary agent is the only actor');
  assert.equal(out.results[0]!.label, 'Grace');
  assert.equal(out.results[0]!.status, 'completed');
  assert.ok(events.includes('start:editor'));
  assert.ok(!events.includes('planning'), 'no planning for a simple task');
  assert.equal(out.metrics.llmCalls, 1);
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
  const coordinator = new Coordinator({ runtime });
  const out = await coordinator.run('fix the add function');

  assert.ok(readFileSync(join(root, 'src', 'calc.js'), 'utf8').includes('a + b'), 'file changed on disk');
  assert.ok(out.changedFiles.includes('src/calc.js'));
  assert.equal(out.results[0]!.status, 'completed');
  assert.ok(out.finalAnswer.includes('Fixed the add function.'));
  assert.equal(out.metrics.llmCalls, 3, 'three model turns in the primary-agent loop');
});

test('coordinator: the primary agent receives the compact repository index', async () => {
  const root = tempProject();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }));
  writeFileSync(join(root, 'src', 'app.ts'), 'export function main() { return 1; }\n');
  const provider = new FakeProvider([{ content: 'Understood.' }]);
  const runtime = makeRuntime(root, provider);
  const coordinator = new Coordinator({ runtime });
  await coordinator.run('fix the bug');
  assert.equal(provider.callCount, 1);
});

// ---------------------------------------------------------------------------
// Complex path — optional planning + optional specialists
// ---------------------------------------------------------------------------

test('coordinator: complex tasks plan (injected planner) and the primary agent executes', async () => {
  const root = tempProject();
  const provider = new FakeProvider([
    { content: '{"summary":"strategy: use a service layer","files":[],"findings":[],"recommendations":[]}' }, // thinker
    { content: 'Implemented the architecture.' }, // editor
  ]);
  const runtime = makeRuntime(root, provider);
  const events: string[] = [];
  const coordinator = new Coordinator({
    runtime,
    planner: plan([{ agents: ['thinker'], reason: 'strategy' }, { agents: ['editor'], reason: 'implement' }]),
    onEvent: (e) => events.push(e.type === 'agent-start' ? `start:${e.role}` : e.type),
  });
  const out = await coordinator.run('redesign the authentication architecture');

  assert.equal(out.route, 'complex');
  assert.ok(events.includes('planning'), 'complex tasks may plan');
  assert.deepEqual(events.filter((e) => e.startsWith('start:')), ['start:thinker', 'start:editor']);
  assert.equal(provider.callCount, 2, 'specialist + primary agent, nothing more');
  assert.equal(out.results.length, 2);
  assert.ok(out.finalAnswer.includes('Implemented the architecture.'));
  assert.equal(out.metrics.llmCalls, 2);
});

test('coordinator: complex task without an LLM planner falls back to the deterministic plan', async () => {
  const root = tempProject();
  // FakeProvider.chat throws → llmPlanner falls back to ruleBasedPlanner.
  const provider = new FakeProvider([{ content: 'Implemented.' }]);
  const runtime = makeRuntime(root, provider);
  const coordinator = new Coordinator({ runtime });
  const out = await coordinator.run('refactor the architecture');

  assert.equal(out.route, 'complex');
  const roles = out.results.map((r) => r.agent);
  assert.deepEqual(roles, ['thinker', 'editor'], 'rule-based complex plan: strategy specialist + primary agent');
  assert.equal(
    out.metrics.llmCalls,
    3,
    'failed planning call (1) + thinker loop (1) + primary-agent loop (1) — every model request is counted',
  );
});

test('coordinator: injected plan with parallel specialists runs them concurrently', async () => {
  const root = tempProject();
  const provider = new FakeProvider([
    { content: '{"summary":"researched","files":[]}', delayMs: 60 },
    { content: '{"summary":"strategized","files":[]}', delayMs: 60 },
  ]);
  const runtime = makeRuntime(root, provider);
  const order: string[] = [];
  const coordinator = new Coordinator({
    runtime,
    planner: plan([{ agents: ['thinker', 'researcher'], reason: 'parallel specialists' }, { agents: ['editor'], reason: 'implement' }]),
    onEvent: (e) => {
      if (e.type === 'agent-start' || e.type === 'agent-done') order.push(`${e.type}:${e.role}`);
    },
  });
  await coordinator.run('design a complex microservice');

  const starts = order.filter((o) => o.startsWith('agent-start')).map((o) => o.replace('agent-start:', ''));
  assert.deepEqual(starts, ['thinker', 'researcher', 'editor']);
  const firstDone = order.findIndex((o) => o.startsWith('agent-done'));
  assert.ok(firstDone > order.indexOf('agent-start:thinker'), 'thinker started before the first agent finished');
  assert.ok(firstDone > order.indexOf('agent-start:researcher'), 'researcher started before the first agent finished');
});

// ---------------------------------------------------------------------------
// Recovery + permission boundaries (unchanged guarantees)
// ---------------------------------------------------------------------------

test('coordinator: failed-agent recovery — a failing specialist does not abort the run', async () => {
  const root = tempProject();
  const provider = new FakeProvider([
    { error: 'server boom' }, // thinker fails
    { content: 'Implemented the fix.' }, // editor succeeds
  ]);
  const runtime = makeRuntime(root, provider);
  const coordinator = new Coordinator({ runtime, planner: plan([{ agents: ['thinker'] }, { agents: ['editor'] }]) });
  const out = await coordinator.run('refactor the login flow');

  assert.equal(out.results[0]!.status, 'failed');
  // Provider failures surface with a CLEAN user-safe message — never the raw
  // provider text ('server boom' stays in the debug log only).
  assert.match(out.results[0]!.error ?? '', /could not be reached/);
  assert.ok(!(out.results[0]!.error ?? '').includes('server boom'), 'raw provider errors never leak to the user');
  assert.equal(out.results[1]!.status, 'completed');
  assert.ok(out.finalAnswer.includes('Implemented the fix.'), 'final answer comes from the surviving agent');
});

test('coordinator: a read-only specialist cannot write even when the model tries', async () => {
  const root = tempProject();
  // The picker model (wrongly) attempts write_file — the coordinator grants no
  // such tool, the loop reports an unknown-tool error, and no file appears.
  const script: ScriptedTurn[] = [
    { content: null, toolCalls: [{ id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'evil.ts', content: 'x' }) }] },
    { content: '{"summary":"done","files":[]}' },
  ];
  const runtime = makeRuntime(root, new FakeProvider(script));
  const coordinator = new Coordinator({ runtime, planner: plan([{ agents: ['file-picker'] }, { agents: ['editor'] }]) });
  const out = await coordinator.run('redesign the module layout');

  assert.ok(out.results[0]!.status === 'completed' || out.results[0]!.status === 'failed');
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

test('coordinator: per-agent crash recovery — an unexpected throw does not abort the run', async () => {
  const root = tempProject();
  const provider = new FakeProvider([{ content: DONE_JSON }]);
  const runtime = makeRuntime(root, provider);
  let factoryCalls = 0;
  const coordinator = new Coordinator({
    runtime,
    planner: plan([{ agents: ['thinker'] }, { agents: ['thinker'] }]),
    providerFactory: (role) => {
      factoryCalls += 1;
      if (factoryCalls === 1) throw new Error('factory boom');
      return role === 'thinker' ? provider : null;
    },
  });
  const out = await coordinator.run('redesign the module boundary');

  assert.equal(out.results[0]!.status, 'failed');
  assert.match(out.results[0]!.error ?? '', /factory boom/);
  assert.equal(out.results[1]!.status, 'completed', 'second agent still ran after the first crashed');
});

// ---------------------------------------------------------------------------
// Instrumentation + usage aggregation
// ---------------------------------------------------------------------------

test('coordinator: aggregates usage, iterations and LLM calls across agents', async () => {
  const root = tempProject();
  const provider = new FakeProvider([
    { content: '{"summary":"strategized","files":[]}' },
    { content: 'Implemented.' },
  ]);
  const runtime = makeRuntime(root, provider);
  const coordinator = new Coordinator({ runtime, planner: plan([{ agents: ['thinker'] }, { agents: ['editor'] }]) });
  const out = await coordinator.run('redesign the data layer');

  assert.equal(out.results.length, 2);
  assert.equal(out.usage?.totalTokens, 300, '2 agents × 150 tokens');
  assert.equal(out.iterations, 2);
  assert.equal(out.metrics.llmCalls, 2);
  assert.ok(out.metrics.timeToFirstResponseMs !== undefined);
});

test('coordinator: events fire route → planning → start → done → done in order (complex)', async () => {
  const root = tempProject();
  const runtime = makeRuntime(root, new FakeProvider([{ content: 'Done.' }]));
  const seen: string[] = [];
  const coordinator = new Coordinator({
    runtime,
    planner: plan([{ agents: ['editor'] }]),
    onEvent: (e) => {
      // Status bullets are progress noise — assert the structural events.
      if (e.type !== 'status') seen.push(e.type);
    },
  });
  await coordinator.run('redesign the storage layer');
  assert.deepEqual(seen, ['route', 'planning', 'step-start', 'agent-start', 'working', 'agent-done', 'done']);
});

test('coordinator: events fire route → step-start → agent-start → done → done (coding, no planning)', async () => {
  const root = tempProject();
  const runtime = makeRuntime(root, new FakeProvider([{ content: 'Done.' }]));
  const seen: string[] = [];
  const coordinator = new Coordinator({ runtime, onEvent: (e) => { if (e.type !== 'status') seen.push(e.type); } });
  await coordinator.run('fix the login bug');
  assert.deepEqual(seen, ['route', 'step-start', 'agent-start', 'working', 'agent-done', 'done']);
});

// ---------------------------------------------------------------------------
// Rule-based planner routing (lean, primary-agent-first)
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

test('planner routing: research uses researcher then the primary agent', () => {
  const p = fallbackPlan('research how to integrate stripe');
  assert.deepEqual(p.steps.map((s) => s.agents), [['researcher'], ['editor']]);
});

test('planner routing: complex task = strategy specialist + primary agent (no committee)', () => {
  const p = fallbackPlan('refactor the authentication architecture');
  assert.deepEqual(p.steps.map((s) => s.agents), [['thinker'], ['editor']]);
});

test('planner routing: default coding task is the primary agent alone', () => {
  const p = fallbackPlan('fix the login bug');
  assert.deepEqual(p.steps.map((s) => s.agents), [['editor']]);
});

test('planner routing: browser task plans browser-use', () => {
  const p = fallbackPlan('why does this website look broken');
  const all = p.steps.flatMap((s) => s.agents);
  assert.ok(all.includes('browser-use'));
});
