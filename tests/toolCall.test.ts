/**
 * Unit tests for tool-call argument validation (src/agent/toolCall.ts).
 *
 * Covers strict validation, the CONSERVATIVE repairs (code fences, prose
 * wrapping) and the cases we must NOT repair because guessing could change the
 * requested tool arguments (truncated objects, concatenated objects).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseToolCallArguments, sanitizeArgumentsForWire, ToolCallParseError } from '../src/agent/toolCall.ts';

function expectInvalid(raw: string, label: string): void {
  assert.throws(() => parseToolCallArguments(raw), ToolCallParseError, label);
}

test('parses valid JSON arguments untouched', () => {
  const { args, repaired } = parseToolCallArguments('{"path":"src/a.js","depth":2}');
  assert.deepEqual(args, { path: 'src/a.js', depth: 2 });
  assert.equal(repaired, false);
});

test('parses empty/whitespace arguments as a valid empty object', () => {
  const { args, repaired } = parseToolCallArguments('   ');
  assert.deepEqual(args, {});
  assert.equal(repaired, false);
});

test('rejects non-object JSON (arrays, strings, numbers, null)', () => {
  expectInvalid('[1,2,3]', 'array is not a valid argument object');
  expectInvalid('"hello"', 'string is not a valid argument object');
  expectInvalid('42', 'number is not a valid argument object');
  expectInvalid('null', 'null is not a valid argument object');
});

test('repairs a JSON object wrapped in a code fence (unambiguous)', () => {
  const { args, repaired } = parseToolCallArguments('```json\n{"path":"src/a.ts"}\n```');
  assert.deepEqual(args, { path: 'src/a.ts' });
  assert.equal(repaired, true);
});

test('repairs a JSON object wrapped in a bare fence (no language tag)', () => {
  const { args, repaired } = parseToolCallArguments('```\n{"path":"src/a.ts"}\n```');
  assert.deepEqual(args, { path: 'src/a.ts' });
  assert.equal(repaired, true);
});

test('repairs a single complete JSON object surrounded by prose', () => {
  const { args, repaired } = parseToolCallArguments('Sure, here you go: {"path":"src/a.ts"}');
  assert.deepEqual(args, { path: 'src/a.ts' });
  assert.equal(repaired, true);
});

test('rejects a truncated object (unterminated — cannot know the intent)', () => {
  expectInvalid('{"path":"src/a.', 'truncated object');
});

test('rejects two concatenated objects (ambiguous — could drop the second call)', () => {
  expectInvalid('{"path":"a"}{"path":"b"}', 'concatenated objects');
});

test('rejects an incomplete object followed by prose', () => {
  expectInvalid('{"path":"a" and then something else', 'incomplete object with trailing prose');
});

test('rejects unbalanced braces / garbage', () => {
  expectInvalid('{not json at all', 'garbage');
  expectInvalid('path: src/a.ts', 'no object at all');
});

test('ToolCallParseError carries redacted, truncated raw arguments', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  try {
    parseToolCallArguments(`{"path":"${secret}" and more`);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ToolCallParseError);
    assert.ok(!err.rawArguments.includes('sk-abcdefghijklmnopqrstuvwxyz123456'), 'secrets are redacted');
    assert.ok(err.rawArguments.length <= 400, 'diagnostics are bounded');
  }
});

test('sanitizeArgumentsForWire keeps valid JSON and replaces invalid with {}', () => {
  assert.equal(sanitizeArgumentsForWire('{"path":"a"}'), '{"path":"a"}');
  assert.equal(sanitizeArgumentsForWire('{oops'), '{}');
  assert.equal(sanitizeArgumentsForWire(''), '{}');
});
