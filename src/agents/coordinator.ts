import type { AIProvider, ChatMessage, ChatOptions, ChatResult, Usage } from '../providers/types.ts';
import { TaskCancelledError } from '../agent/loop.ts';
import { ProjectIndexService } from '../project/index.ts';
import type { Runtime } from '../runtime.ts';
import { MemorySession } from '../session/memory.ts';
import { createTools } from '../tools/registry.ts';
import { browserAvailability } from './browser.ts';
import { capabilitiesAreReadOnly, commandPolicyForRole, toolsForCapabilities } from './capabilities.ts';
import { classifyTask, conversationReply, type TaskRoute } from './fastRouter.ts';
import { compactResults, compactText } from './compact.ts';
import { DEFAULT_PRIMARY_PLAN, llmPlanner, normalizePlan, ruleBasedPlanner } from './planner.ts';
import { AGENT_SPECS, ALL_AGENT_ROLES } from './specs.ts';
import { runSubagent } from './subagent.ts';
import { runDeterministicTestRunner } from './testRunner.ts';
import type {
  AgentRole,
  AgentSpec,
  AgentPlan,
  CoordinatorEvent,
  CoordinatorRunResult,
  Planner,
  PlannerInput,
  RunMetrics,
  SubagentResult,
  ToolEvent,
} from './types.ts';

export interface CoordinatorDeps {
  runtime: Runtime;
  /**
   * Per-role provider factory (model routing extension point). The primary
   * agent (editor) normally uses the runtime's configured provider directly;
   * optional specialists may resolve their own model here. Return null to
   * fall back to the runtime provider. NO_LLM roles are deterministic.
   */
  providerFactory?: (role: AgentRole, spec: AgentSpec) => AIProvider | null;
  /** Provider for the coordinator's own planning call (complex tasks only). */
  plannerProvider?: AIProvider | null;
  /** Replaceable planner (tests inject scripted plans). */
  planner?: Planner;
  /** Progress events for the CLI (never chain-of-thought). */
  onEvent?: (event: CoordinatorEvent) => void;
  /** Structured tool-level events (tool-start/end, file-changed, permission-*). */
  onToolEvent?: (event: ToolEvent) => void;
  /** Max agents running at once within a parallel step. */
  maxConcurrency?: number;
  /** Token budget for the compacted context handed to the next step. */
  resultTokenBudget?: number;
  /** Shared project index (maintained across tasks when reused). */
  projectIndex?: ProjectIndexService;
  /** Max review→fix rounds after the editor runs (default 1, 0 disables). */
  fixRounds?: number;
  /** Abort signal: Ctrl+C during a task cancels the run safely. */
  signal?: AbortSignal;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RESULT_BUDGET = 4_000;

interface Accumulator {
  changedFiles: Set<string>;
  iterations: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface RunClock {
  startedAt: number;
  firstStatusAt?: number;
  firstToolAt?: number;
}

function mergeUsage(acc: Accumulator, usage: Usage | undefined): void {
  if (!usage) return;
  acc.inputTokens += usage.inputTokens;
  acc.outputTokens += usage.outputTokens;
  acc.totalTokens += usage.totalTokens;
}

/**
 * Wrap a provider so every successful chat call reports its usage + counts
 * one LLM call (used to capture the optional planning call's tokens — no
 * internal model call is ever omitted from the run's usage).
 */
function trackedProvider(
  base: AIProvider | null,
  onResult: (res: ChatResult) => void,
  onCall: () => void,
): AIProvider | null {
  if (!base) return null;
  return new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'chat' && typeof value === 'function') {
        return async (messages: ChatMessage[], options?: ChatOptions): Promise<ChatResult> => {
          onCall();
          const res = (await value.call(target, messages, options)) as ChatResult;
          onResult(res);
          return res;
        };
      }
      return value;
    },
  }) as AIProvider;
}

/**
 * The GRACE coordinator (primary-agent architecture).
 *
 *   User request
 *      ↓
 *   Fast local router (deterministic — no model call)
 *      ↓
 *   conversation → local reply (0 LLM calls)   tests → deterministic runner (0 LLM calls)
 *      ↓
 *   Primary Agent (default) ← optional planning for complex tasks
 *      ↓
 *   Tools: search → read → edit/write → run commands → fix errors → repeat
 *
 * The primary agent is the default execution path. Specialist subagents only
 * run when a complex plan explicitly includes them; the coordinator stays the
 * orchestrator and composes the final answer from the agent results.
 */
export class Coordinator {
  private readonly deps: CoordinatorDeps;
  private readonly index: ProjectIndexService;
  /** Serializes user permission prompts so parallel agents never interleave. */
  private askQueue: Promise<void> = Promise.resolve();

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
    this.index = deps.projectIndex ?? new ProjectIndexService(deps.runtime.root);
  }

  async run(task: string): Promise<CoordinatorRunResult> {
    const startedAt = Date.now();
    const clock: RunClock = { startedAt };
    // All events flow through this wrapper so timing instrumentation is cheap
    // and centralized (spec: measure time to first response / first tool call).
    const emit = (e: CoordinatorEvent): void => {
      if (e.type === 'status') {
        if (clock.firstStatusAt === undefined) clock.firstStatusAt = Date.now();
        if (clock.firstToolAt === undefined && e.message.trim().startsWith('→')) clock.firstToolAt = Date.now();
      }
      this.deps.onEvent?.(e);
    };

    const route = classifyTask(task).route;
    emit({ type: 'route', route });

    // Conversational input: answered locally — zero model calls, zero tools,
    // zero repository scanning.
    if (route === 'conversation') {
      emit({ type: 'done' });
      return {
        task,
        route,
        plan: { steps: [], notes: 'conversation' },
        results: [],
        finalAnswer: conversationReply(task),
        changedFiles: [],
        iterations: 0,
        toolCalls: 0,
        metrics: { llmCalls: 0 },
      };
    }

    // Test runs: the deterministic runner — zero model calls.
    if (route === 'tests') {
      return this.runTests(task, emit);
    }

    const { runtime } = this.deps;
    const index = this.index.get();
    const browser = browserAvailability();
    const unavailable: AgentRole[] = browser.available ? [] : ['browser-use'];
    const available = ALL_AGENT_ROLES.filter((r) => !unavailable.includes(r));

    // Planning is optional and reserved for complex tasks. Everything else
    // starts the primary agent immediately.
    this.throwIfAborted();
    let plan: AgentPlan;
    let plannerCalls = 0;
    let plannerUsage: Usage | undefined;
    if (route === 'complex') {
      emit({ type: 'planning' });
      const resolved = await this.resolvePlan(task, index.summary, available, unavailable, () => (plannerCalls += 1), (res) => (plannerUsage = res.usage));
      plan = resolved;
    } else {
      plan = DEFAULT_PRIMARY_PLAN;
    }
    this.throwIfAborted();

    const acc: Accumulator = { changedFiles: new Set(), iterations: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    mergeUsage(acc, plannerUsage);
    const results: SubagentResult[] = [];

    for (let s = 0; s < plan.steps.length; s += 1) {
      this.throwIfAborted();
      const step = plan.steps[s] as AgentPlan['steps'][number];
      emit({ type: 'step-start', step: s + 1, total: plan.steps.length });
      // Narrow context: compacted summaries of prior steps + the repository
      // index — never raw tool dumps or full conversations.
      const contextText = compactResults(results, this.deps.resultTokenBudget ?? DEFAULT_RESULT_BUDGET);
      this.merge(acc, results, await this.runStep(step.agents, task, contextText, index.summary, unavailable, emit));
    }

    // Bounded review→fix loop: only when a reviewer actually ran with
    // actionable findings (never by default — review stays optional).
    const fixRounds = this.deps.fixRounds ?? 1;
    for (let round = 0; round < fixRounds; round += 1) {
      const reviewer = results.find((r) => r.agent === 'code-reviewer' && r.status === 'completed');
      const editorRan = results.some((r) => r.agent === 'editor');
      const needsFix = editorRan && reviewer !== undefined && reviewer.recommendations.length > 0;
      if (!needsFix) break;
      const contextText = compactResults(results, this.deps.resultTokenBudget ?? DEFAULT_RESULT_BUDGET);
      this.merge(acc, results, await this.runStep(['editor'], `${task}\n\nAddress the review findings above.`, contextText, index.summary, unavailable, emit));
      const testPlanned = plan.steps.some((s) => s.agents.includes('test-runner'));
      if (testPlanned) {
        const verifyCtx = compactResults(results, this.deps.resultTokenBudget ?? DEFAULT_RESULT_BUDGET);
        this.merge(acc, results, await this.runStep(['test-runner'], `${task}\n\nRe-run the relevant tests after the fix.`, verifyCtx, index.summary, unavailable, emit));
      }
    }

    const finalAnswer = composeFinalAnswer(results, unavailable);
    emit({ type: 'done' });

    return {
      task,
      route,
      plan,
      results,
      finalAnswer,
      changedFiles: [...acc.changedFiles],
      iterations: acc.iterations,
      toolCalls: acc.toolCalls,
      usage: acc.totalTokens > 0 ? { inputTokens: acc.inputTokens, outputTokens: acc.outputTokens, totalTokens: acc.totalTokens } : undefined,
      metrics: this.buildMetrics(clock, acc, plannerCalls),
    };
  }

  // -------------------------------------------------------------------------
  // Paths that never touch a model
  // -------------------------------------------------------------------------

  private async runTests(task: string, emit: (e: CoordinatorEvent) => void): Promise<CoordinatorRunResult> {
    const spec = AGENT_SPECS['test-runner'] as AgentSpec;
    emit({ type: 'agent-start', role: 'test-runner', label: spec.label });
    const result = await runDeterministicTestRunner({
      projectRoot: this.deps.runtime.root,
      project: this.deps.runtime.project,
    });
    emit({
      type: 'agent-done',
      role: 'test-runner',
      label: spec.label,
      status: result.status,
      summary: result.summary,
      error: result.error,
    });
    emit({ type: 'done' });
    return {
      task,
      route: 'tests',
      plan: { steps: [{ agents: ['test-runner'], reason: 'Run the tests.' }] },
      results: [result],
      finalAnswer: composeFinalAnswer([result], []),
      changedFiles: [],
      iterations: 0,
      toolCalls: 0,
      metrics: { llmCalls: 0 },
    };
  }

  // -------------------------------------------------------------------------
  // Optional planning (complex tasks only)
  // -------------------------------------------------------------------------

  /**
   * Resolve the plan for a complex task. An injected planner (tests) wins;
   * otherwise the LLM planner runs on the reasoning tier and falls back to the
   * deterministic rule-based planner. The planning call's usage is captured so
   * no internal model call is omitted from the run total.
   */
  private async resolvePlan(
    task: string,
    indexSummary: string,
    available: AgentRole[],
    unavailable: AgentRole[],
    onCall: () => void,
    onResult: (res: ChatResult) => void,
  ): Promise<AgentPlan> {
    const input: PlannerInput = { task, indexSummary, availableAgents: available, unavailableAgents: unavailable };
    if (this.deps.planner) return normalizePlan(await this.deps.planner(input), ALL_AGENT_ROLES);
    const provider = trackedProvider(this.deps.plannerProvider ?? this.deps.runtime.provider, onResult, onCall);
    return llmPlanner(provider)(input);
  }

  // -------------------------------------------------------------------------
  // Plan execution
  // -------------------------------------------------------------------------

  /** Fold a step's results into the shared accumulator + results list. */
  private merge(acc: Accumulator, results: SubagentResult[], stepResults: SubagentResult[]): void {
    for (const r of stepResults) {
      results.push(r);
      acc.iterations += r.iterations;
      acc.toolCalls += r.toolCalls;
      mergeUsage(acc, r.usage);
      // Only agents that actually hold the write capability can have changed
      // files — a read-only agent's spurious/attempted write must never show
      // up in the final "Changed files:" list.
      const spec = AGENT_SPECS[r.agent] as AgentSpec;
      if (spec.capabilities.includes('write')) {
        for (const f of r.changedFiles) acc.changedFiles.add(f);
      }
    }
  }

  /** Run one plan step: independent agents in parallel, bounded concurrency. */
  private async runStep(
    roles: AgentRole[],
    task: string,
    contextText: string,
    indexSummary: string,
    unavailable: AgentRole[],
    emit: (e: CoordinatorEvent) => void,
  ): Promise<SubagentResult[]> {
    const cap = Math.max(1, Math.min(this.deps.maxConcurrency ?? DEFAULT_CONCURRENCY, roles.length));
    const out: SubagentResult[] = new Array<SubagentResult>(roles.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < roles.length) {
        const i = next;
        next += 1;
        out[i] = await this.runOne(roles[i] as AgentRole, task, contextText, indexSummary, unavailable, emit);
      }
    };

    await Promise.all(Array.from({ length: cap }, () => worker()));
    return out;
  }

  private async runOne(
    role: AgentRole,
    task: string,
    contextText: string,
    indexSummary: string,
    unavailable: AgentRole[],
    emit: (e: CoordinatorEvent) => void,
  ): Promise<SubagentResult> {
    const { runtime } = this.deps;
    const spec = AGENT_SPECS[role] as AgentSpec;

    emit({ type: 'agent-start', role, label: spec.label });
    if (role === 'editor') emit({ type: 'working' });

    // Unavailable roles (browser-use without a browser backend) are reported
    // cleanly instead of silently doing nothing.
    if (unavailable.includes(role)) {
      const reason = browserAvailability().reason ?? 'not available';
      const res: SubagentResult = {
        agent: role,
        label: spec.label,
        status: 'unavailable',
        summary: `Browser verification is unavailable: ${reason}`,
        files: [],
        changedFiles: [],
        findings: [],
        recommendations: [],
        error: reason,
        iterations: 0,
        toolCalls: 0,
      };
      emit({ type: 'agent-done', role, label: spec.label, status: 'unavailable', summary: res.summary, error: reason });
      return res;
    }

    // Defense in depth: a read-only spec must never carry write/execute tools.
    if (spec.readOnly && !capabilitiesAreReadOnly(spec.capabilities)) {
      return this.fail(spec, 'Permission boundary violation: read-only role granted mutating tools.', emit);
    }

    // NO_LLM roles (e.g. the test runner) run deterministically — no model
    // request is consumed and no provider is built.
    if (spec.modelTier === 'no_llm') {
      return this.runNoLlm(role, spec, emit);
    }

    try {
      const provider = this.deps.providerFactory ? (this.deps.providerFactory(role, spec) ?? runtime.provider) : runtime.provider;
      if (!provider) return this.fail(spec, 'No AI provider is configured.', emit);

      const session = role === 'editor' ? runtime.session : new MemorySession();
      const tools = toolsForCapabilities(
        createTools({
          projectRoot: runtime.root,
          askPermission: this.serializedAsk,
          undo: runtime.undo,
          commandPolicy: commandPolicyForRole(role),
        }),
        spec.capabilities,
      );

      // Repo-aware roles (the primary agent + strategy specialists) receive
      // the compact index summary so they never re-scan the whole repository.
      const context = ['editor', 'thinker', 'project-scout'].includes(role)
        ? `Index:\n${compactText(indexSummary, 2_000)}\n\n${contextText}`
        : contextText;

      const result = await runSubagent(
        {
          provider,
          tools,
          projectRoot: runtime.root,
          project: runtime.project,
          session,
          undo: runtime.undo,
          askPermission: this.serializedAsk,
          onStatus: (msg) => emit({ type: 'status', message: msg }),
          onToolEvent: (e) => {
            // A single channel to the UI: tool events flow through onEvent,
            // and the dedicated onToolEvent callback stays available for
            // consumers that want tool activity separately from progress.
            emit(e);
            this.deps.onToolEvent?.(e);
          },
          signal: this.deps.signal,
        },
        spec,
        task,
        context,
      );

      emit({ type: 'agent-done', role, label: spec.label, status: result.status, summary: result.summary, error: result.error });
      return result;
    } catch (err) {
      // A user cancellation must propagate (not be swallowed by recovery).
      if (err instanceof TaskCancelledError) throw err;
      // Per-agent recovery: an unexpected crash must never abort the run.
      return this.fail(spec, `Agent crashed: ${(err as Error).message ?? String(err)}`, emit);
    }
  }

  /** Stop immediately when the user cancelled the task (Ctrl+C). */
  private throwIfAborted(): void {
    if (this.deps.signal?.aborted) throw new TaskCancelledError();
  }

  /**
   * Deterministic execution for NO_LLM roles. Today only the test runner has
   * one; unknown roles fail cleanly instead of silently doing nothing.
   */
  private async runNoLlm(role: AgentRole, spec: AgentSpec, emit: (e: CoordinatorEvent) => void): Promise<SubagentResult> {
    if (role === 'test-runner') {
      const result = await runDeterministicTestRunner({
        projectRoot: this.deps.runtime.root,
        project: this.deps.runtime.project,
      });
      emit({
        type: 'agent-done',
        role,
        label: spec.label,
        status: result.status,
        summary: result.summary,
        error: result.error,
      });
      return result;
    }
    return this.fail(spec, `Role "${role}" is marked no_llm but has no deterministic executor.`, emit);
  }

  private fail(spec: AgentSpec, error: string, emit: (e: CoordinatorEvent) => void): SubagentResult {
    const res: SubagentResult = {
      agent: spec.role,
      label: spec.label,
      status: 'failed',
      summary: error,
      files: [],
      changedFiles: [],
      findings: [],
      recommendations: [],
      error,
      iterations: 0,
      toolCalls: 0,
    };
    emit({ type: 'agent-done', role: spec.role, label: spec.label, status: 'failed', summary: error, error });
    return res;
  }

  /** User permission prompts are serialized so parallel agents cannot interleave. */
  private readonly serializedAsk = async (command: string, reasons: string[]): Promise<boolean> => {
    const prev = this.askQueue;
    let release = (): void => undefined;
    this.askQueue = new Promise((r) => (release = r));
    await prev;
    try {
      return await this.deps.runtime.ask(command, reasons);
    } finally {
      release();
    }
  };

  /** Build the run's instrumentation record. */
  private buildMetrics(clock: RunClock, acc: Accumulator, plannerCalls: number): RunMetrics {
    const metrics: RunMetrics = { llmCalls: plannerCalls + acc.iterations };
    if (clock.firstStatusAt !== undefined) metrics.timeToFirstResponseMs = clock.firstStatusAt - clock.startedAt;
    if (clock.firstToolAt !== undefined) metrics.timeToFirstToolCallMs = clock.firstToolAt - clock.startedAt;
    return metrics;
  }
}

/** Compose the user-facing final answer from the structured results. */
export function composeFinalAnswer(results: SubagentResult[], unavailable: AgentRole[]): string {
  // The LAST editor run wins (a review→fix pass supersedes the first attempt).
  const editor = [...results].reverse().find((r) => r.agent === 'editor');
  const completed = results.filter((r) => r.status === 'completed');
  const parts: string[] = [];

  if (editor) {
    if (editor.status === 'completed') parts.push(editor.summary);
    else if (editor.status === 'failed') parts.push(`The task failed: ${editor.error ?? editor.summary}`);
  } else if (completed.length > 0) {
    parts.push((completed[completed.length - 1] as SubagentResult).summary);
  }

  const reviewer = results.find((r) => r.agent === 'code-reviewer' && r.status === 'completed');
  if (reviewer) {
    const notes = reviewer.recommendations.length > 0 ? reviewer.recommendations.slice(0, 3) : reviewer.findings.slice(0, 3);
    if (notes.length > 0) parts.push(`Review: ${notes.join(' ')}`);
  }

  const tester = results.find((r) => r.agent === 'test-runner' && r.status === 'completed');
  if (tester && tester.summary) parts.push(`Tests: ${tester.summary}`);

  const browserResult = results.find((r) => r.agent === 'browser-use' && r.status === 'unavailable');
  if (browserResult) parts.push(browserResult.summary);

  if (parts.length === 0) {
    const failed = results.filter((r) => r.status === 'failed');
    if (failed.length > 0) {
      return `The task could not be completed.\n${failed.map((f) => `${f.label}: ${f.error ?? f.summary}`).join('\n')}`;
    }
    return 'The task could not be completed.';
  }

  return parts.filter(Boolean).join('\n\n');
}

/** Re-export the route type for consumers. */
export type { TaskRoute };
