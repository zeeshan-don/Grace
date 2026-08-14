import type { AIProvider, ChatMessage, StreamEvent, ToolCallParam, ToolDefinition, Usage } from '../providers/types.ts';
import type { ProjectInfo } from '../project/detect.ts';
import { gitAwareness } from '../git/git.ts';
import type { ConversationStore } from '../session/session.ts';
import type { UndoStore } from '../session/undo.ts';
import { isProtectedPath, resolveInProject } from '../safety/policy.ts';
import type { Tool } from '../tools/registry.ts';
import { truncateMiddle } from '../util/text.ts';
import type { ToolEvent } from '../agents/types.ts';
import { buildSystemPrompt, projectBits, DEFAULT_CONTEXT_BUDGET, trimMessages } from './context.ts';
import { providerError, formatRunError, type TaskRunError } from './errors.ts';
import { scrub } from '../providers/errors.ts';
import { parseToolCallArguments, sanitizeArgumentsForWire, sanitizeRawForLog, type ToolCallParseError } from './toolCall.ts';
import { ToolCache } from './toolCache.ts';

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
  /**
   * Called with structured tool-level events (tool-start/end, file-changed,
   * permission-request/result). The UI renders these as human-friendly
   * activity instead of raw JSON.
   */
  onToolEvent?: (event: ToolEvent) => void;
  /** Called with streamed assistant text so the CLI can print it live. */
  onStream?: (text: string) => void;
  /** Overridable permission handler (REPL prompt, --yes, or test stub). */
  askPermission?: (command: string, reasons: string[]) => Promise<boolean>;
  /** Abort signal: Ctrl+C during a task cancels the run safely. */
  signal?: AbortSignal;
  maxIterations?: number;
  contextBudget?: number;
}

/** Thrown when the user cancels an in-flight task (Ctrl+C). */
export class TaskCancelledError extends Error {
  constructor() {
    super('Task cancelled by the user.');
    this.name = 'TaskCancelledError';
  }
}

export interface AgentRunResult {
  finalText: string;
  iterations: number;
  toolCalls: number;
  changedFiles: string[];
  usage?: Usage;
  reachedLimit: boolean;
  /** Classified failure (provider vs parser vs tool), when the run did not complete. */
  error?: TaskRunError;
  // -------------------------------------------------------------------------
  // Instrumentation (task efficiency metrics)
  // -------------------------------------------------------------------------
  durationMs: number;
  /** Time spent waiting on model requests (ms). */
  modelTimeMs: number;
  /** Time spent executing tools (ms). */
  toolTimeMs: number;
  /** Tool calls served from the dedup cache (repeated identical calls). */
  duplicateToolCalls: number;
  /** Tool calls that failed (invalid args, unknown tool, execution error). */
  failedToolCalls: number;
  /** Model request retries (rate-limit backoff). */
  retries: number;
}

const DEFAULT_MAX_ITERATIONS = 30;

/** After this many consecutive turns where NO tool executed, fail cleanly. */
const MAX_CONSECUTIVE_BROKEN_TURNS = 2;

interface ToolCallAccumulator {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
}

/** Result of executing one tool call (drives broken-turn detection). */
type ToolCallOutcome = 'ok' | 'cache' | 'invalid' | 'unknown' | 'error';

export class AgentLoop {
  private readonly ctx: AgentRunContext;
  private readonly toolsByName: Map<string, Tool>;
  private readonly cache = new ToolCache();

  /** Instrumentation accumulated across turns. */
  private readonly metrics = {
    modelTimeMs: 0,
    toolTimeMs: 0,
    duplicateToolCalls: 0,
    failedToolCalls: 0,
    retries: 0,
    brokenTurns: 0,
  };

  /** Sanitized raw arguments of the most recent unparseable tool call. */
  private lastInvalidCall: { name: string; raw: string } | null = null;

  constructor(ctx: AgentRunContext) {
    this.ctx = ctx;
    this.toolsByName = new Map(ctx.tools.map((t) => [t.name, t]));
  }

  async run(input: string): Promise<AgentRunResult> {
    const { session, onStatus } = this.ctx;
    const maxIterations = this.ctx.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const budget = this.ctx.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
    const startedAt = Date.now();

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
    let runError: TaskRunError | undefined;

    onStatus?.('Thinking…');

    while (iterations < maxIterations) {
      this.throwIfAborted();
      iterations += 1;
      const trimmed = trimMessages(messages, budget);

      const { content, toolCalls: calls, streamUsage, error } = await this.runTurn(trimmed, toolDefs);
      this.throwIfAborted();
      if (error) {
        runError = error;
        // A model-output problem (invalid tool call) is never blamed on the
        // provider; only provider-category failures get the provider prefix.
        const isProviderFailure =
          error.category === 'provider_unavailable' ||
          error.category === 'provider_timeout' ||
          error.category === 'provider_authentication';
        finalText = isProviderFailure
          ? `I could not reach the AI provider:\n${error.message}`
          : `The task could not be completed.\n${error.message}`;
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

      // The assistant message is sanitized BEFORE it enters the conversation:
      // OpenAI-compatible providers reject assistant messages whose tool-call
      // arguments are not valid JSON (a 400 that used to surface as a bogus
      // "provider unreachable"). The model still receives the real error via
      // the tool-result channel.
      const wireCalls = sanitizeCallsForWire(calls);
      messages.push({ role: 'assistant', content, tool_calls: wireCalls });
      session.pushMessage({ role: 'assistant', content, tool_calls: wireCalls });

      if (calls.length === 0) {
        finalText = content ?? '';
        break;
      }

      toolCalls += calls.length;
      const outcomes: ToolCallOutcome[] = [];
      for (const call of calls) {
        this.throwIfAborted();
        outcomes.push(await this.executeTool(call, messages));
        this.trackChangedFiles(changedFiles, call);
      }

      // Broken-turn detection: the model kept producing tool calls that could
      // not execute (malformed arguments / unknown tools) with zero progress.
      // Fail with a clean InvalidToolCall classification instead of looping
      // until the iteration cap.
      const allBroken = outcomes.length > 0 && outcomes.every((o) => o === 'invalid' || o === 'unknown');
      if (allBroken) {
        this.metrics.brokenTurns += 1;
        if (this.metrics.brokenTurns >= MAX_CONSECUTIVE_BROKEN_TURNS) {
          const detail = this.lastInvalidCall
            ? `latest: tool "${this.lastInvalidCall.name}" had invalid JSON arguments (${sanitizeRawForLog(this.lastInvalidCall.raw).length} chars).`
            : 'the model called tools that do not exist.';
          runError = {
            category: 'invalid_tool_call',
            message: `The model repeatedly produced tool calls that could not be executed safely (${detail})`,
            providerId: this.ctx.provider.id,
            providerLabel: this.ctx.provider.label,
            modelId: this.ctx.provider.getModel().id,
            rawArguments: this.lastInvalidCall?.raw,
          };
          finalText = `I stopped because the model kept producing tool calls that could not be executed safely.\n${formatRunError(runError)}`;
          session.pushMessage({ role: 'assistant', content: finalText });
          break;
        }
      } else {
        this.metrics.brokenTurns = 0;
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
      error: runError,
      durationMs: Date.now() - startedAt,
      modelTimeMs: this.metrics.modelTimeMs,
      toolTimeMs: this.metrics.toolTimeMs,
      duplicateToolCalls: this.metrics.duplicateToolCalls,
      failedToolCalls: this.metrics.failedToolCalls,
      retries: this.metrics.retries,
    };
  }

  private toolDefs(): ToolDefinition[] {
    return this.ctx.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  /** Stop immediately when the user cancelled the task (Ctrl+C). */
  private throwIfAborted(): void {
    if (this.ctx.signal?.aborted) throw new TaskCancelledError();
  }

  /**
   * Stream one model turn, collecting content and tool-call deltas.
   *
   * Rate-limit / too-large rejections are retried with a short exponential
   * backoff (bounded). This happens strictly at the model-request boundary:
   * the turn's tools have NOT executed yet, so a retry can never duplicate
   * tool work. Any other failure surfaces immediately, classified into the
   * run-error taxonomy (never just "the provider is down").
   */
  private async runTurn(
    messages: ChatMessage[],
    toolDefs: ToolDefinition[],
  ): Promise<{ content: string; toolCalls: ToolCallParam[]; streamUsage?: Usage; error?: TaskRunError }> {
    const { provider, onStream } = this.ctx;
    const MAX_TURN_ATTEMPTS = 3;
    const BACKOFF_MS = [0, 1_500, 3_000];
    let lastError = '';

    for (let attempt = 0; attempt < MAX_TURN_ATTEMPTS; attempt += 1) {
      if (attempt > 0) this.metrics.retries += 1;
      let content = '';
      const acc = new Map<number, ToolCallAccumulator>();
      let usage: Usage | undefined;
      const turnStart = performance.now();
      try {
        this.throwIfAborted();
        const events = provider.streamChat(messages, { tools: toolDefs, temperature: 0.2, signal: this.ctx.signal });
        for await (const event of events) {
          if (event.type === 'content') {
            content += event.content;
            onStream?.(event.content);
          } else if (event.type === 'tool_call_delta') {
            let cur = acc.get(event.index);
            // Some providers reuse the same index for a NEW tool call (the id
            // changes). Merging them would concatenate two JSON objects into
            // one unparseable blob — open a fresh slot instead.
            if (event.id && cur?.id && cur.id !== event.id) {
              let free = event.index + 1;
              while (acc.has(free)) free += 1;
              cur = { index: free, arguments: '' };
              acc.set(free, cur);
            }
            if (!cur) {
              cur = { index: event.index, arguments: '' };
              acc.set(event.index, cur);
            }
            if (event.id) cur.id = event.id;
            if (event.name) cur.name = event.name;
            if (event.argumentsDelta) cur.arguments += event.argumentsDelta;
          } else if (event.type === 'done') {
            if (event.usage) usage = event.usage;
          }
        }
        this.metrics.modelTimeMs += performance.now() - turnStart;
        const toolCalls: ToolCallParam[] = [...acc.values()]
          .sort((a, b) => a.index - b.index)
          .map((a) => ({
            id: a.id ?? `call_${a.index}`,
            name: a.name ?? 'unknown',
            arguments: a.arguments || '{}',
          }));
        return { content, toolCalls, streamUsage: usage };
      } catch (err) {
        this.metrics.modelTimeMs += performance.now() - turnStart;
        // A user cancellation is not a provider failure — surface it as such.
        if (this.ctx.signal?.aborted) throw new TaskCancelledError();
        lastError = (err as Error).message ?? String(err);
        const rateLimited = /rate.?limit|TPM|too large|429|413/i.test(lastError);
        const parseError = /failed to parse tool call arguments/i.test(lastError);
        const isLastAttempt = attempt >= MAX_TURN_ATTEMPTS - 1;

        if (parseError) {
          // The MODEL emitted tool-call arguments that the provider could not
          // parse as JSON (e.g. Groq: "Failed to parse tool call arguments as
          // JSON"). This is a model-output problem — NOT a provider outage.
          // Recover via the provider's structured (non-streaming) path first:
          // when supported, it returns complete, validated tool calls.
          this.metrics.retries += 1;
          const structured = await this.tryStructuredToolCall(messages, toolDefs);
          if (structured) return structured;
          // The structured path failed too — one more streaming attempt, then
          // give up with a classified InvalidToolCall.
          console.error(`[grace:tool-call] provider rejected malformed tool-call arguments: ${scrub(lastError)}`);
          if (isLastAttempt) {
            const error: TaskRunError = {
              category: 'invalid_tool_call',
              message: `The model emitted tool calls with malformed JSON arguments and the provider could not parse them. ${scrub(lastError)}`,
              providerId: provider.id,
              providerLabel: provider.label,
              modelId: provider.getModel().id,
            };
            return { content, toolCalls: [], error };
          }
          continue; // same context, one more chance for a valid tool call
        }

        if (!rateLimited || isLastAttempt) {
          const hint = rateLimited
            ? '\n\nThe provider rate limit was hit or the request was too large. The router tries a fallback provider automatically; you can also wait a moment and retry, or use /model to pick a smaller/faster model.'
            : '';
          const error = providerError(lastError + hint, {
            id: provider.id,
            label: provider.label,
            modelId: provider.getModel().id,
          });
          console.error(`[grace:provider] ${provider.id} failed (${error.category}): ${error.message}`);
          return { content, toolCalls: [], error };
        }
        const delay = (BACKOFF_MS[attempt] as number) ?? 1_000;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
    }
    const error = providerError(lastError, { id: provider.id, label: provider.label, modelId: provider.getModel().id });
    return { content: '', toolCalls: [], error };
  }

  /**
   * Recover a turn whose streamed tool call was rejected as malformed JSON by
   * asking the provider for a STRUCTURED (non-streaming) completion. Returns
   * the turn result when the provider supports it and answered; null when the
   * provider's structured path is unavailable or also failed.
   */
  private async tryStructuredToolCall(
    messages: ChatMessage[],
    toolDefs: ToolDefinition[],
  ): Promise<{ content: string; toolCalls: ToolCallParam[]; streamUsage?: Usage } | null> {
    const { provider, onStream } = this.ctx;
    const supportsStructured = provider.getModel().supportedFeatures.includes('tool_calls');
    if (!supportsStructured) return null;
    const start = performance.now();
    try {
      const result = await provider.chat(messages, { tools: toolDefs, temperature: 0.2, signal: this.ctx.signal });
      this.metrics.modelTimeMs += performance.now() - start;
      if (result.content) onStream?.(result.content);
      return { content: result.content ?? '', toolCalls: result.toolCalls, streamUsage: result.usage };
    } catch (err) {
      this.metrics.modelTimeMs += performance.now() - start;
      // The structured path failed (or the provider rejects it) — the caller
      // decides what to do next; never surface a raw error here.
      return null;
    }
  }

  /**
   * Validate + execute one tool call. Never throws for model- or tool-level
   * problems: errors are reported back to the model through the tool-result
   * channel so the task can recover. Returns an outcome used by the loop's
   * broken-turn detection.
   */
  private async executeTool(call: ToolCallParam, messages: ChatMessage[]): Promise<ToolCallOutcome> {
    const { onStatus, onToolEvent, session } = this.ctx;
    const tool = this.toolsByName.get(call.name);

    // 1. Validate arguments BEFORE execution (conservative repair only).
    let args: Record<string, unknown>;
    try {
      const parsed = parseToolCallArguments(call.arguments);
      args = parsed.args;
      if (parsed.repaired) {
        console.error(
          `[grace:tool-call] ${call.name} — repaired malformed arguments (fence/prose stripped): ${sanitizeRawForLog(call.arguments)}`,
        );
      }
    } catch (err) {
      const e = err as ToolCallParseError;
      this.lastInvalidCall = { name: call.name, raw: e.rawArguments };
      this.metrics.failedToolCalls += 1;
      const diag = `Tool call "${call.name}" had invalid JSON arguments. Raw (redacted): ${e.rawArguments}`;
      console.error(`[grace:tool-call] ${call.name} — invalid JSON arguments, refusing to execute: ${e.rawArguments}`);
      const reply =
        `Error: ${diag}\n` +
        `The arguments could not be parsed as a single JSON object. Re-issue this tool call with valid JSON arguments (no code fences, no extra text).`;
      messages.push({ role: 'tool', tool_call_id: call.id, content: reply });
      session.recordToolCall(diag);
      onToolEvent?.({ type: 'tool-end', tool: call.name, ok: false });
      return 'invalid';
    }

    // 2. Unknown tool (model hallucination) — same recovery channel.
    if (!tool) {
      this.metrics.failedToolCalls += 1;
      const err = `Unknown tool "${call.name}". Available: ${[...this.toolsByName.keys()].join(', ')}`;
      messages.push({ role: 'tool', tool_call_id: call.id, content: `Error: ${err}` });
      session.recordToolCall(err);
      onToolEvent?.({ type: 'tool-end', tool: call.name, ok: false });
      return 'unknown';
    }

    // 3. Mutating tools invalidate the dedup cache (search results recompute;
    //    file reads re-validate via mtime anyway).
    if (call.name === 'write_file' || call.name === 'edit_file' || call.name === 'run_command') {
      this.cache.invalidate();
    }

    // 4. Dedup: an identical, unchanged read/search is served from cache.
    const cached = this.tryCacheHit(call.name, args);
    if (cached !== null) {
      this.metrics.duplicateToolCalls += 1;
      messages.push({ role: 'tool', tool_call_id: call.id, content: cached });
      return 'cache';
    }

    const brief = JSON.stringify(args).slice(0, 140);
    onStatus?.(`→ ${call.name} ${brief}`);
    session.recordToolCall(`${call.name} ${brief}`);

    onToolEvent?.({ type: 'tool-start', tool: call.name, args });
    const execStart = performance.now();
    try {
      const result = await tool.execute(args, {
        projectRoot: this.ctx.projectRoot,
        askPermission: async (cmd, reasons) => {
          onStatus?.(`⚠ "${cmd}" flagged (${reasons.join('; ')}) — asking user…`);
          onToolEvent?.({ type: 'permission-request', command: cmd, reasons });
          let allowed = false;
          if (this.ctx.askPermission) allowed = await this.ctx.askPermission(cmd, reasons);
          onToolEvent?.({ type: 'permission-result', command: cmd, allowed });
          return allowed;
        },
        onTool: (n, a) => onStatus?.(`    ⚙ ${n} ${JSON.stringify(a).slice(0, 100)}`),
      });
      this.metrics.toolTimeMs += performance.now() - execStart;
      onToolEvent?.({ type: 'tool-end', tool: call.name, ok: true });
      const content = truncateMiddle(result, 20_000);
      this.cacheResult(call.name, args, result);
      messages.push({ role: 'tool', tool_call_id: call.id, content });
      return 'ok';
    } catch (err) {
      this.metrics.toolTimeMs += performance.now() - execStart;
      this.metrics.failedToolCalls += 1;
      onToolEvent?.({ type: 'tool-end', tool: call.name, ok: false });
      const msg = `Error executing ${call.name}: ${(err as Error).message}`;
      messages.push({ role: 'tool', tool_call_id: call.id, content: msg });
      return 'error';
    }
  }

  /** Serve an identical read/list/search from cache when nothing changed. */
  private tryCacheHit(tool: string, args: Record<string, unknown>): string | null {
    if (tool === 'read_file') {
      const p = args.path;
      if (typeof p !== 'string' || !p) return null;
      const resolved = resolveInProject(this.ctx.projectRoot, p);
      if (!resolved.ok) return null;
      if (isProtectedPath(resolved.real) || isProtectedPath(resolved.abs)) return null;
      return this.cache.getCachedRead(resolved.abs);
    }
    if (tool === 'list_directory') {
      const rawPath = typeof args.path === 'string' ? args.path : '';
      const depth = typeof args.depth === 'number' ? args.depth : 1;
      const resolved = rawPath
        ? resolveInProject(this.ctx.projectRoot, rawPath)
        : { abs: this.ctx.projectRoot, real: this.ctx.projectRoot, ok: true as const };
      if (!resolved.ok) return null;
      return this.cache.getCachedListing(resolved.abs, depth);
    }
    if (tool === 'search_files') {
      return this.cache.getCachedSearch(JSON.stringify(args));
    }
    return null;
  }

  /** Remember a successful read/list/search result for future dedup. */
  private cacheResult(tool: string, args: Record<string, unknown>, result: string): void {
    // Never cache failures — a transient error must not be replayed.
    if (result.startsWith('Error:')) return;
    if (tool === 'read_file') {
      const p = args.path;
      if (typeof p !== 'string' || !p) return;
      const resolved = resolveInProject(this.ctx.projectRoot, p);
      if (!resolved.ok) return;
      if (isProtectedPath(resolved.real) || isProtectedPath(resolved.abs)) return;
      this.cache.setRead(resolved.abs, result);
    } else if (tool === 'list_directory') {
      const rawPath = typeof args.path === 'string' ? args.path : '';
      const depth = typeof args.depth === 'number' ? args.depth : 1;
      const resolved = rawPath
        ? resolveInProject(this.ctx.projectRoot, rawPath)
        : { abs: this.ctx.projectRoot, real: this.ctx.projectRoot, ok: true as const };
      if (!resolved.ok) return;
      this.cache.setListing(resolved.abs, depth, result);
    } else if (tool === 'search_files') {
      this.cache.setSearch(JSON.stringify(args), result);
    }
  }

  private trackChangedFiles(changed: Set<string>, call: ToolCallParam): void {
    if (call.name !== 'write_file' && call.name !== 'edit_file') return;
    try {
      const args = JSON.parse(call.arguments) as { path?: string };
      if (args.path) {
        changed.add(args.path);
        this.ctx.onToolEvent?.({ type: 'file-changed', path: args.path });
      }
    } catch {
      /* ignore */
    }
  }
}

/** Copy tool calls so malformed arguments never reach the provider's wire. */
function sanitizeCallsForWire(calls: ToolCallParam[]): ToolCallParam[] {
  return calls.map((c) => ({ ...c, arguments: sanitizeArgumentsForWire(c.arguments) }));
}
