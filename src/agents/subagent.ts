import { AgentLoop } from '../agent/loop.ts';
import type { AIProvider } from '../providers/types.ts';
import type { ProjectInfo } from '../project/detect.ts';
import type { ConversationStore } from '../session/session.ts';
import type { UndoStore } from '../session/undo.ts';
import type { Tool } from '../tools/registry.ts';
import { compactText } from './compact.ts';
import { parseStructuredResult } from './structured.ts';
import type { AgentSpec, SubagentResult } from './types.ts';

/** AgentLoop prefixes provider failures with this text (see loop.ts runTurn). */
const PROVIDER_FAILURE_MARKER = 'I could not reach the AI provider';

export interface RunSubagentOptions {
  provider: AIProvider;
  /** Tools already filtered down to the role's capability grant. */
  tools: Tool[];
  projectRoot: string;
  project: ProjectInfo;
  /** MemorySession for subagents; the persistent Session for the editor. */
  session: ConversationStore;
  undo: UndoStore;
  askPermission: (command: string, reasons: string[]) => Promise<boolean>;
  /** Progress status lines (tool actions) forwarded to the CLI. */
  onStatus?: (msg: string) => void;
}

/**
 * Execute one specialized agent.
 *
 * The agent is a normal AgentLoop run with three restrictions that define the
 * permission boundary: a role system prompt, a capability-filtered tool set
 * (already enforced by the coordinator) and a throwaway in-memory session.
 * Output is compacted into a structured SubagentResult.
 */
export async function runSubagent(
  opts: RunSubagentOptions,
  spec: AgentSpec,
  task: string,
  contextText: string,
): Promise<SubagentResult> {
  const systemPrompt = `${spec.systemPrompt}\n\nContext:\n${compactText(contextText, 12_000)}`;

  const loop = new AgentLoop({
    provider: opts.provider,
    tools: opts.tools,
    projectRoot: opts.projectRoot,
    project: opts.project,
    session: opts.session,
    undo: opts.undo,
    systemPrompt,
    askPermission: opts.askPermission,
    maxIterations: spec.maxIterations,
    contextBudget: spec.contextBudget,
    onStatus: opts.onStatus,
  });

  const result = await loop.run(task);

  const failed = result.finalText.startsWith(PROVIDER_FAILURE_MARKER);
  const parsed = spec.structured ? parseStructuredResult(result.finalText) : null;

  const files = dedupe([...(parsed?.files ?? []), ...result.changedFiles]);
  const summary = failed
    ? result.finalText
    : (parsed?.summary?.trim() || result.finalText || '(no response)');

  return {
    agent: spec.role,
    label: spec.label,
    status: failed ? 'failed' : 'completed',
    summary,
    files,
    changedFiles: result.changedFiles,
    findings: parsed?.findings ?? [],
    recommendations: parsed?.recommendations ?? [],
    error: failed ? summary : undefined,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
    usage: result.usage,
  };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
