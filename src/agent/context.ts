import type { ChatMessage } from '../providers/types.ts';
import type { ProjectInfo } from '../project/detect.ts';
import { estimateTokens } from '../util/text.ts';

/** Soft budget for conversation context sent to the model (tokens). */
export const DEFAULT_CONTEXT_BUDGET = 28_000;
const MAX_TOOL_CONTENT_CHARS = 8_000;

/** Compact one-line project descriptor shared by the default and subagent prompts. */
export function projectBits(info: ProjectInfo): string {
  const bits = [`${info.type}${info.framework ? `/${info.framework}` : ''}`, `pm:${info.packageManager}`];
  if (info.languages.length) bits.push(`lang:${info.languages.join('+')}`);
  if (info.testCommand) bits.push(`test:${info.testCommand}`);
  if (info.buildCommand) bits.push(`build:${info.buildCommand}`);
  return bits.join(' · ');
}

export function buildSystemPrompt(info: ProjectInfo): string {
  const projectBitsText = projectBits(info);

  return [
    'You are ZEESH AI, a coding agent working in the user\'s repository.',
    `Project: ${projectBitsText} · root ${info.root}`,
    '',
    'Workflow:',
    '- Inspect with read_file/search_files/list_directory before editing.',
    '- Minimal edits: edit_file for changes, write_file for new files.',
    '- After editing, run tests/build/lint via run_command; read errors, fix, re-run until green.',
    '- When done, stop and report: files changed + how you verified.',
    '',
    'Rules:',
    '- Never read/write .env, keys, credentials or SSH material.',
    '- Destructive commands (rm -rf, sudo, git push/reset, DB drops) are gated by a permission prompt; if denied, find a safe alternative. Never bypass it.',
    '- Never fabricate tool results. Only report what tools returned.',
    '- Keep reads focused; do not dump whole repos into context.',
  ].join('\n');
}

/**
 * Trim messages to fit the token budget (Milestone "context management").
 * Keeps the system prompt, drops the oldest tool results and middle messages
 * first, and truncates oversized tool contents.
 */
export function trimMessages(messages: ChatMessage[], budget: number): ChatMessage[] {
  let trimmed = messages.map((m) => {
    if (m.role === 'tool' && m.content && m.content.length > MAX_TOOL_CONTENT_CHARS) {
      return { ...m, content: m.content.slice(0, MAX_TOOL_CONTENT_CHARS) + '\n… [tool result truncated]' };
    }
    return m;
  });

  const total = trimmed.reduce((acc, m) => acc + estimateTokens(m.content ?? ''), 0);
  if (total <= budget) return trimmed;

  // Drop oldest tool results, then middle messages, until under budget.
  let over = total - budget;
  let i = 1; // keep index 0 (system)
  while (over > 0 && i < trimmed.length) {
    const m = trimmed[i] as ChatMessage;
    const cost = estimateTokens(m.content ?? '');
    if (m.role === 'tool' || m.role === 'assistant') {
      trimmed.splice(i, 1);
      over -= cost;
    } else {
      i += 1;
    }
  }
  // Last resort: drop middle messages — but never the user's own request
  // (index 1) nor the newest message.
  let j = 2;
  while (over > 0 && j < trimmed.length - 1) {
    const m = trimmed[j] as ChatMessage;
    const cost = estimateTokens(m.content ?? '');
    trimmed.splice(j, 1);
    over -= cost;
    if (trimmed[j]?.role === 'tool') {
      over -= estimateTokens(trimmed[j]?.content ?? '');
      trimmed.splice(j, 1);
    }
  }
  return trimmed;
}
