/**
 * Tool-call argument validation (agent loop).
 *
 * Model tool calls arrive as a JSON string. Streaming deltas are concatenated
 * and small models occasionally emit malformed JSON (stray prose, code fences,
 * truncated objects). This module:
 *
 *  1. validates arguments BEFORE execution,
 *  2. applies only UNAMBIGUOUS, conservative repairs (code-fence stripping,
 *     extracting a single complete JSON object) — it never guesses, because
 *     guessing could change the requested tool arguments,
 *  3. fails safely with a `ToolCallParseError` carrying sanitized diagnostics,
 *  4. provides `sanitizeArgumentsForWire` so malformed arguments never reach
 *     the provider's wire format (OpenAI-compatible APIs reject assistant
 *     messages whose tool-call arguments are not valid JSON — which is the
 *     original "Failed to parse tool call arguments as JSON" 400).
 */
import { redactSecrets } from '../safety/policy.ts';

/** Max characters of raw arguments kept in diagnostics (redacted first). */
const MAX_DIAG_CHARS = 400;

export class ToolCallParseError extends Error {
  /** Sanitized (redacted + truncated) raw arguments for diagnostics/logs. */
  readonly rawArguments: string;

  constructor(message: string, rawArguments: string) {
    super(message);
    this.name = 'ToolCallParseError';
    this.rawArguments = rawArguments;
  }
}

export interface ParsedToolCall {
  args: Record<string, unknown>;
  /** True when the raw string had to be repaired (fence/prose stripped). */
  repaired: boolean;
}

/** Redact secrets + truncate raw arguments before they are logged or shown. */
export function sanitizeRawForLog(raw: string): string {
  return redactSecrets(raw).slice(0, MAX_DIAG_CHARS);
}

/** Strict parse: only a JSON object is acceptable (arrays/strings/numbers are not). */
function tryParse(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Extract the FIRST balanced JSON object from a string. Returns null when the
 * object is incomplete OR when non-whitespace follows it (e.g. two concatenated
 * objects) — in both cases repairing could change the requested arguments.
 */
function extractBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        if (text.slice(i + 1).trim() === '') return candidate;
        return null; // trailing content — ambiguous, do not guess
      }
    }
  }
  return null; // unterminated object — truncated
}

/** Conservative repair; returns null when nothing unambiguous is possible. */
function repair(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;

  // Code fences: ```json {…} ``` or ``` {…} ``` — wrapping is unambiguous.
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence && fence[1]) {
    const inner = fence[1].trim();
    if (tryParse(inner)) return inner;
  }

  // A single complete JSON object with surrounding prose/whitespace.
  const balanced = extractBalancedObject(text);
  if (balanced !== null && tryParse(balanced)) return balanced;

  return null;
}

/**
 * Parse + validate tool-call arguments. Throws ToolCallParseError when the
 * raw string cannot be safely turned into an argument object.
 */
export function parseToolCallArguments(raw: string): ParsedToolCall {
  if (raw.trim() === '') return { args: {}, repaired: false };

  const direct = tryParse(raw);
  if (direct) return { args: direct, repaired: false };

  const fixed = repair(raw);
  if (fixed !== null) {
    const parsed = tryParse(fixed);
    if (parsed) return { args: parsed, repaired: true };
  }

  throw new ToolCallParseError('Tool call arguments are not valid JSON.', sanitizeRawForLog(raw));
}

/**
 * Ensure assistant messages never carry malformed tool-call arguments to the
 * provider. Returns the original string when it is valid JSON, otherwise a
 * safe `{}` placeholder — the loop reports the real error to the model through
 * the tool-result channel, so the provider never 400s on our own message.
 */
export function sanitizeArgumentsForWire(raw: string): string {
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return '{}';
  }
}
