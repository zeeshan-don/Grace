import assert from 'node:assert/strict';
import test from 'node:test';
import { trimMessages } from '../src/agent/context.ts';
import type { ChatMessage } from '../src/providers/types.ts';
import { estimateTokens } from '../src/util/text.ts';

function bigText(chars: number): string {
  return 'x'.repeat(chars);
}

test('estimateTokens is ~chars/4', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.ok(estimateTokens('x'.repeat(400)) >= 95 && estimateTokens('x'.repeat(400)) <= 105);
});

test('trimMessages keeps system prompt and drops oldest tool results when over budget', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first request' },
    { role: 'assistant', content: bigText(1000) },
    { role: 'tool', content: bigText(4000) },
    { role: 'assistant', content: bigText(1000) },
    { role: 'tool', content: bigText(4000) },
    { role: 'assistant', content: bigText(1000) },
    { role: 'tool', content: bigText(4000) },
    { role: 'assistant', content: 'final answer' },
  ];
  const budget = 3000;
  const trimmed = trimMessages(messages, budget);
  const total = trimmed.reduce((acc, m) => acc + estimateTokens(m.content ?? ''), 0);
  assert.ok(total <= budget + 500, `trimmed total ${total} exceeds budget ${budget}`);
  assert.equal(trimmed[0]?.role, 'system');
  assert.equal(trimmed[1]?.role, 'user');
  assert.ok(trimmed.length < messages.length, 'should have dropped old messages');
  // The newest assistant answer survives
  assert.equal(trimmed[trimmed.length - 1]?.content, 'final answer');
});

test('trimMessages truncates oversized tool results', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
    { role: 'tool', tool_call_id: 'c1', content: bigText(50_000) },
  ];
  const trimmed = trimMessages(messages, 100_000);
  const toolMsg = trimmed[trimmed.length - 1];
  assert.ok((toolMsg?.content?.length ?? 0) <= 8500, 'tool content should be truncated');
  assert.ok(toolMsg?.content?.includes('truncated'));
});
