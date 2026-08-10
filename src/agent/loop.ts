import type { AIProvider, ChatMessage, StreamEvent, ToolCallParam, ToolDefinition, Usage } from '../providers/types.ts';
import type { ProjectInfo } from '../project/detect.ts';
import { gitAwareness } from '../git/git.ts';
import type { ConversationStore } from '../session/session.ts';
import type { UndoStore } from '../session/undo.ts';
import type { Tool } from '../tools/registry.ts';
import { truncateMiddle } from '../util/text.ts';
import { buildSystemPrompt, projectBits, DEFAULT_CONTEXT_BUDGET, trimMessages } from './context.ts';

export interface AgentRunContext {
  provider: AIProvider;
  tools: Tool[];
  projectRoot: string;
  project: ProjectInfo;
  /** Conversation store — the persistent Session or a subagent MemorySession. */
  session: ConversationStore;
  undo: UndoStore;
  /** Override the default project system prompt (used by subagents). */
  systemPrompt?: string;
  /** Called with status lines (dim, prefixed). */
  onStatus?: (msg: string) => void;
  /** Called with streamed assistant text so the CLI can print it live. */
  onStream?: (text: string) => void;
  /** Overridable permission handler (REPL prompt, --yes, or test stub). */
  askPermission?: (command: string, reasons: string[]) => Promise<boolean>;
  maxIterations?: number;
  contextBudget?: number;
}

export interface AgentRunResult {
  finalText: string;
  iterations: number;
  toolCalls: number;
  changedFiles: string[];
  usage?: Usage;
  reachedLimit: boolean;
}

const DEFAULT_MAX_ITERATIONS = 30;

interface ToolCallAccumulator {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
}

export class AgentLoop {
  private readonly ctx: AgentRunContext;
  private readonly toolsByName: Map<string, Tool>;

  constructor(ctx: AgentRunContext) {
    this.ctx = ctx;
    this.toolsByName = new Map(ctx.tools.map((t) => [t.name, t]));
  }

  async run(input: string): Promise<AgentRunResult> {
    const { session, onStatus } = this.ctx;
    const maxIterations = this.ctx.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const budget = this.ctx.contextBudget ?? DEFAULT_CONTEXT_BUDGET;

    session.beginRun();
    session.pushMessage({ role: 'user', content: input });
    const defaultSystem = buildSystemPrompt(this.ctx.project);
    const system = this.ctx.systemPrompt
      ? `${this.ctx.systemPrompt}\n\nProject: ${projectBits(this.ctx.project)}\nGit:\n${gitAwareness(this.ctx.projectRoot)}`
      : `${defaultSystem}\n\nGit:\n${gitAwareness(this.ctx.projectRoot)}`;
    const messages: ChatMessage[] = [{ role: 'system', content: system }, ...session.messages];
    const toolDefs = this.toolDefs();

    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let iterations = 0;
    let toolCalls = 0;
    const changedFiles = new Set<string>();
    let finalText = '';
    let reachedLimit = false;

    onStatus?.('Thinking…');

    while (iterations < maxIterations) {
      iterations += 1;
      const trimmed = trimMessages(messages, budget);

      const { content, toolCalls: calls, streamUsage, error } = await this.runTurn(trimmed, toolDefs);
      if (error) {
        finalText = `I could not reach the AI provider:\n${error}`;
        session.pushMessage({ role: 'assistant', content: finalText });
        break;
      }
      if (streamUsage) {
        usage = {
          inputTokens: usage.inputTokens + streamUsage.inputTokens,
          outputTokens: usage.outputTokens + streamUsage.outputTokens,
          totalTokens: usage.totalTokens + streamUsage.totalTokens,
        };
      }

      messages.push({ role: 'assistant', content, tool_calls: calls });
      session.pushMessage({ role: 'assistant', content, tool_calls: calls });

      if (calls.length === 0) {
        finalText = content ?? '';
        break;
      }

      toolCalls += calls.length;
      for (const call of calls) {
        await this.executeTool(call, messages);
        this.trackChangedFiles(changedFiles, call);
      }

      if (iterations >= maxIterations) {
        reachedLimit = true;
        finalText = `I reached the ${maxIterations}-iteration limit before finishing.\nLatest progress: ${content ?? '(no text)'}\n\nSay "continue" and I will keep going.`;
      }
    }

    if (!finalText) {
      finalText = 'Reached the iteration limit without a final answer.';
    }

    session.addUsage(usage.inputTokens, usage.outputTokens);
    session.save();
    onStatus?.(`Done in ${iterations} iteration(s), ${toolCalls} tool call(s).`);

    return {
      finalText,
      iterations,
      toolCalls,
      changedFiles: [...changedFiles],
      usage: usage.totalTokens > 0 ? usage : undefined,
      reachedLimit,
    };
  }

  private toolDefs(): ToolDefinition[] {
    return this.ctx.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  /** Stream one model turn, collecting content and tool-call deltas. */
  private async runTurn(
    messages: ChatMessage[],
    toolDefs: ToolDefinition[],
  ): Promise<{ content: string; toolCalls: ToolCallParam[]; streamUsage?: Usage; error?: string }> {
    const { provider, onStream } = this.ctx;
    let content = '';
    const acc = new Map<number, ToolCallAccumulator>();
    let usage: Usage | undefined;

    try {
      const events = provider.streamChat(messages, { tools: toolDefs, temperature: 0.2 });
      for await (const event of events) {
        if (event.type === 'content') {
          content += event.content;
          onStream?.(event.content);
        } else if (event.type === 'tool_call_delta') {
          const cur = acc.get(event.index) ?? { index: event.index, arguments: '' };
          if (event.id) cur.id = event.id;
          if (event.name) cur.name = event.name;
          if (event.argumentsDelta) cur.arguments += event.argumentsDelta;
          acc.set(event.index, cur);
        } else if (event.type === 'done') {
          if (event.usage) usage = event.usage;
        }
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const rateLimited = /rate.?limit|TPM|too large|429|413/i.test(message);
      const hint = rateLimited
        ? '\n\nThe provider rate limit was hit (your Groq plan caps tokens/minute). Try /model to pick a smaller/faster model, wait a moment, and retry.'
        : '';
      return { content, toolCalls: [], error: message + hint };
    }

    const toolCalls: ToolCallParam[] = [...acc.values()]
      .sort((a, b) => a.index - b.index)
      .map((a) => ({
        id: a.id ?? `call_${a.index}`,
        name: a.name ?? 'unknown',
        arguments: a.arguments || '{}',
      }));

    return { content, toolCalls, streamUsage: usage };
  }

  private async executeTool(call: ToolCallParam, messages: ChatMessage[]): Promise<void> {
    const { onStatus, session } = this.ctx;
    const tool = this.toolsByName.get(call.name);

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.arguments) as Record<string, unknown>;
    } catch {
      const err = `Tool call "${call.name}" had invalid JSON arguments: ${call.arguments}`;
      messages.push({ role: 'tool', tool_call_id: call.id, content: `Error: ${err}` });
      session.recordToolCall(err);
      return;
    }

    if (!tool) {
      const err = `Unknown tool "${call.name}". Available: ${[...this.toolsByName.keys()].join(', ')}`;
      messages.push({ role: 'tool', tool_call_id: call.id, content: `Error: ${err}` });
      session.recordToolCall(err);
      return;
    }

    const brief = JSON.stringify(args).slice(0, 140);
    onStatus?.(`→ ${call.name} ${brief}`);
    session.recordToolCall(`${call.name} ${brief}`);

    try {
      const result = await tool.execute(args, {
        projectRoot: this.ctx.projectRoot,
        askPermission: async (cmd, reasons) => {
          onStatus?.(`⚠ "${cmd}" flagged (${reasons.join('; ')}) — asking user…`);
          if (this.ctx.askPermission) return this.ctx.askPermission(cmd, reasons);
          return false;
        },
        onTool: (n, a) => onStatus?.(`    ⚙ ${n} ${JSON.stringify(a).slice(0, 100)}`),
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content: truncateMiddle(result, 20_000) });
    } catch (err) {
      const msg = `Error executing ${call.name}: ${(err as Error).message}`;
      messages.push({ role: 'tool', tool_call_id: call.id, content: msg });
    }
  }

  private trackChangedFiles(changed: Set<string>, call: ToolCallParam): void {
    if (call.name !== 'write_file' && call.name !== 'edit_file') return;
    try {
      const args = JSON.parse(call.arguments) as { path?: string };
      if (args.path) changed.add(args.path);
    } catch {
      /* ignore */
    }
  }
}
