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
    'You are GRACE, a coding agent working in the user\'s repository.',
    `Project: ${projectBitsText} · root ${info.root}`,
    '',
    'Before changing anything, identify the application:',
    '- Establish the project type, framework, dependency/config files, likely entry points, source directories and test setup from the Index/context and config files (package.json, pyproject.toml, requirements.txt, Cargo.toml, go.mod, ...).',
    '- Never assume a file is the application entry point because of its name (hello.py may be a scratch script). Locate the real server/API entry point before editing.',
    '',
    'Workflow:',
    '- Inspect with read_file/search_files/list_directory before editing. Reuse what the Index already tells you instead of re-searching for it.',
    '- Minimal edits: edit_file for changes, write_file for new files.',
    '- After editing, run tests/build/lint via run_command; read errors, fix, re-run until green. Never start long-running servers or background processes to validate — use bounded checks (import/compile checks, unit tests, short one-shot probes).',
    '- When done, stop and report: files changed + how you verified.',
    '',
    'Rules:',
    '- Never read/write .env, keys, credentials or SSH material.',
    '- NEVER install or add dependencies (pip install, npm install <pkg>, poetry add, ...) unless the project already declares the dependency AND the user approved it. Inspect the dependency files first; the permission prompt enforces this.',
    '- Destructive commands (rm -rf, sudo, git push/reset, DB drops) are gated by a permission prompt; if denied, find a safe alternative. Never bypass it.',
    '- Never fabricate tool results. Only report what tools returned.',
    '- Keep reads focused; do not dump whole repos into context. Do not re-read a file you already have unless it may have changed.',
  ].join('\n');
}

/**
 * Explicit file-ish targets named in a task (package.json, src/auth.ts,
 * tests/calc.test.py, …). General — nothing is special-cased per file.
 */
const FILE_TARGET_RE =
  /\b(?:[A-Za-z0-9_./-]*[A-Za-z0-9_])\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|json|toml|ya?ml|md|txt|sh|css|html|sql|c|cpp|h)\b/gi;

/**
 * Task-scope guidance for targeted requests (GRACE context efficiency).
 *
 * "Inspect package.json and find bugs" should read package.json and answer —
 * not browse api/health.ts, src/api/handlers.ts or unrelated tests. When the
 * user's task explicitly names one to three files, the agent gets a crisp
 * scope rule: read those files plus their immediate dependencies, and only
 * broaden exploration when the named files actually require it. Tasks that
 * name no file (or name many) keep the default broad-exploration behavior.
 * Returns '' (no hint) when the task is not a targeted-file task.
 */
export function taskScopeHint(task: string): string {
  const targets = [
    ...new Set(
      (task.match(FILE_TARGET_RE) ?? []).map((m) => m.replace(/[.,;:!?]+$/, '')),
    ),
  ];
  if (targets.length === 0 || targets.length > 3) return '';
  return [
    'Task scope (targeted):',
    `- The task explicitly names: ${targets.join(', ')}.`,
    '- Read ONLY those files plus the immediate dependencies they reference (imports, config, helpers they call).',
    '- Do NOT browse the repository for related code, entry points, directories or tests unless one of the named files actually requires it.',
    '- Answer the task from those files; if they are insufficient, state that and ask before exploring further.',
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
