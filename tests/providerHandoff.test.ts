/**
 * Provider fallback chain + context handoff tests.
 *
 * Covers the spec's provider tests:
 *   #8  Groq provider-level rate limit → NVIDIA fallback
 *   #9  NVIDIA quota exhaustion → Gemini fallback
 *   #10 Gemini provider failure → MiniMax fallback
 *   #11 All providers fail → clean failure
 *   #12 Malformed tool arguments do NOT trigger provider fallback
 *   #13 Tool execution failure does NOT trigger provider fallback
 *   #14 Normal task failure does NOT trigger provider fallback
 *   #30 Provider handoff preserves task context
 *
 * No real providers are used — scripted stubs and the FakeProvider only.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentLoop } from '../src/agent/loop.ts';
import { detectProject } from '../src/project/detect.ts';
import { Session } from '../src/session/session.ts';
import { UndoStore } from '../src/session/undo.ts';
import { createTools, type Tool } from '../src/tools/registry.ts';
import { FallbackProvider } from '../src/providers/fallback.ts';
import { ProviderError } from '../src/providers/errors.ts';
import type { AIProvider, ChatMessage, ChatOptions, ChatResult, ModelInfo } from '../src/providers/types.ts';
import { FakeProvider, type ScriptedTurn } from './helpers/fakeProvider.ts';

const msgs: ChatMessage[] = [{ role: 'user', content: 'fix the bug' }];

class StubProvider implements AIProvider {
  readonly id: string;
  readonly label: string;
  readonly chatImpl: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResult> | ChatResult;
  calls = 0;
  received: ChatMessage[] | null = null;

  constructor(id: string, chatImpl: (messages: ChatMessage[], options?: ChatOptions) => Promise<ChatResult> | ChatResult) {
    this.id = id;
    this.label = id;
    this.chatImpl = chatImpl;
  }

  getModel(): ModelInfo {
    return { id: `model-${this.id}`, contextWindow: 128_000, supportedFeatures: [] };
  }

  setModel(): void {}
  listModels(): Promise<string[]> {
    return Promise.resolve([`model-${this.id}`]);
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult> {
    this.calls += 1;
    this.received = messages;
    return this.chatImpl(messages, options);
  }

  async *streamChat(): AsyncIterable<never> {
    yield* [];
  }
}

const okResult: ChatResult = { content: 'ok', toolCalls: [], finishReason: 'stop' };

// ---------------------------------------------------------------------------
// #8–#11: the Groq → NVIDIA → Gemini → MiniMax fallback chain
// ---------------------------------------------------------------------------

test('#8 Groq rate limit triggers NVIDIA fallback', async () => {
  const groq = new StubProvider('groq', () => {
    throw new ProviderError('groq', 'rate_limit', 'groq rate limited', 429);
  });
  const nvidia = new StubProvider('nvidia', () => okResult);
  const router = new FallbackProvider([groq, nvidia]);
  const result = await router.chat(msgs);
  assert.equal(result.content, 'ok');
  assert.equal(groq.calls, 1);
  assert.equal(nvidia.calls, 1, 'NVIDIA serves after the Groq rate limit');
  assert.equal(router.lastServed, nvidia);
});

test('#9 Groq rate limit + NVIDIA quota exhaustion → Gemini fallback', async () => {
  const groq = new StubProvider('groq', () => {
    throw new ProviderError('groq', 'rate_limit', 'rate limited', 429);
  });
  const nvidia = new StubProvider('nvidia', () => {
    throw new ProviderError('nvidia', 'quota_exhausted', 'quota exhausted', 429);
  });
  const gemini = new StubProvider('gemini', () => okResult);
  const router = new FallbackProvider([groq, nvidia, gemini]);
  const result = await router.chat(msgs);
  assert.equal(result.content, 'ok');
  assert.equal(gemini.calls, 1, 'Gemini serves after Groq + NVIDIA fail');
  assert.equal(router.lastServed, gemini);
});

test('#10 Gemini provider failure → MiniMax fallback', async () => {
  const groq = new StubProvider('groq', () => {
    throw new ProviderError('groq', 'rate_limit', 'rate limited', 429);
  });
  const nvidia = new StubProvider('nvidia', () => {
    throw new ProviderError('nvidia', 'quota_exhausted', 'quota exhausted', 429);
  });
  const gemini = new StubProvider('gemini', () => {
    throw new ProviderError('gemini', 'server_error', 'gemini outage', 503);
  });
  const minimax = new StubProvider('minimax', () => okResult);
  const router = new FallbackProvider([groq, nvidia, gemini, minimax]);
  const result = await router.chat(msgs);
  assert.equal(result.content, 'ok');
  assert.equal(minimax.calls, 1, 'MiniMax serves as the final fallback');
  assert.equal(router.lastServed, minimax);
});

test('#11 MiniMax failure after all providers produces a clean failure', async () => {
  const chain = ['groq', 'nvidia', 'gemini', 'minimax'].map(
    (id) =>
      new StubProvider(id, () => {
        throw new ProviderError(id, 'network', `${id} unreachable`);
      }),
  );
  const router = new FallbackProvider(chain);
  await assert.rejects(
    () => router.chat(msgs),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.match(err.message, /All AI providers failed/);
      for (const id of ['groq', 'nvidia', 'gemini', 'minimax']) assert.match(err.message, new RegExp(id));
      assert.equal(router.lastServed, null);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// #30: provider handoff preserves task context
// ---------------------------------------------------------------------------

test('#30 the fallback provider hands the full message context to the next provider', async () => {
  const groq = new StubProvider('groq', () => {
    throw new ProviderError('groq', 'rate_limit', 'rate limited', 429);
  });
  const nvidia = new StubProvider('nvidia', () => okResult);
  const router = new FallbackProvider([groq, nvidia]);
  const conversation: ChatMessage[] = [
    { role: 'system', content: 'You are GRACE.' },
    { role: 'user', content: 'Fix the login bug' },
    { role: 'assistant', content: 'Reading the auth file…', tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"src/login.ts"}' }] },
    { role: 'tool', tool_call_id: 'c1', content: '…file body…' },
  ];
  await router.chat(conversation);
  assert.deepEqual(groq.received, conversation, 'the primary sees the full context');
  assert.deepEqual(nvidia.received, conversation, 'the fallback receives the SAME messages — no task state is lost');
});

// ---------------------------------------------------------------------------
// #12–#14: task/model/tool errors must NOT trigger provider fallback
// ---------------------------------------------------------------------------

function loopSetup(root: string) {
  const project = detectProject(root);
  const session = new Session(root);
  const undo = new UndoStore(root);
  const tools: Tool[] = createTools({ projectRoot: root, askPermission: async () => false, undo });
  return { project, session, undo, tools };
}

test('#12 malformed tool arguments do NOT trigger provider fallback (loop recovers in place)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zeesh-handoff-'));
  writeFileSync(join(root, 'a.txt'), 'hello');
  // Two consecutive malformed tool calls — the loop classifies them as
  // invalid_tool_call; the SAME provider keeps serving (callCount 2) and no
  // switch/fallback ever happens.
  const script: ScriptedTurn[] = [
    { content: null, toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{not json' }] },
    { content: null, toolCalls: [{ id: 'c2', name: 'read_file', arguments: '[1,2' }] },
  ];
  const provider = new FakeProvider(script);
  const { project, session, undo, tools } = loopSetup(root);
  const loop = new AgentLoop({ provider, tools, projectRoot: root, project, session, undo });
  const result = await loop.run('read the file');
  assert.equal(result.error?.category, 'invalid_tool_call', 'malformed args are a model/task error, not a provider error');
  assert.equal(provider.callCount, 2, 'the loop retried the SAME provider — no fallback chain involved');
  assert.ok(!/provider/i.test(result.finalText), 'user text does not blame a provider');
});

test('#13 tool execution failure does NOT trigger provider fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zeesh-handoff-'));
  const script: ScriptedTurn[] = [
    // run a command that fails at execution time (blocked tool)
    { content: null, toolCalls: [{ id: 'c1', name: 'run_command', arguments: JSON.stringify({ command: 'definitely-not-a-command-xyz' }) }] },
    { content: 'The command could not run — here is the error.', toolCalls: [] },
  ];
  const provider = new FakeProvider(script);
  const { project, session, undo, tools } = loopSetup(root);
  const loop = new AgentLoop({ provider, tools, projectRoot: root, project, session, undo });
  const result = await loop.run('run the command');
  assert.equal(result.error, undefined, 'the loop recovered by reporting the tool error to the model');
  assert.equal(provider.callCount, 2, 'the same provider served both turns — no switch');
  assert.equal(result.finalText, 'The command could not run — here is the error.');
});

test('#14 a normal task failure (model answers without finishing) does NOT trigger fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zeesh-handoff-'));
  const script: ScriptedTurn[] = [
    { content: null, toolCalls: [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'does-not-exist.ts' }) }] },
    { content: 'I could not find that file.', toolCalls: [] },
  ];
  const provider = new FakeProvider(script);
  const { project, session, undo, tools } = loopSetup(root);
  const loop = new AgentLoop({ provider, tools, projectRoot: root, project, session, undo });
  const result = await loop.run('read the file');
  assert.equal(result.error, undefined);
  assert.equal(provider.callCount, 2, 'recovery happens inside the agent with the same provider');
  assert.equal(result.finalText, 'I could not find that file.');
});
