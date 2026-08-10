import type { AIProvider } from '../providers/types.ts';
import { ProjectIndexService } from '../project/index.ts';
import type { Runtime } from '../runtime.ts';
import { MemorySession } from '../session/memory.ts';
import { createTools } from '../tools/registry.ts';
import { browserAvailability } from './browser.ts';
import { capabilitiesAreReadOnly, commandPolicyForRole, toolsForCapabilities } from './capabilities.ts';
import { compactResults, compactText } from './compact.ts';
import { llmPlanner, ruleBasedPlanner, normalizePlan } from './planner.ts';
import { AGENT_SPECS, ALL_AGENT_ROLES } from './specs.ts';
import { runSubagent } from './subagent.ts';
import type {
  AgentRole,
  AgentSpec,
  AgentPlan,
  CoordinatorEvent,
  CoordinatorRunResult,
  Planner,
  SubagentResult,
} from './types.ts';

export interface CoordinatorDeps {
  runtime: Runtime;
  /**
   * Per-role provider factory (model routing extension point). Defaults to
   * sharing the runtime provider, so every agent uses the user's configured
   * model. Return null to fall back to the runtime provider.
   */
  providerFactory?: (role: AgentRole, spec: AgentSpec) => AIProvider | null;
  /** Replaceable planner (tests inject scripted plans). */
  planner?: Planner;
  /** Progress events for the CLI (never chain-of-thought). */
  onEvent?: (event: CoordinatorEvent) => void;
  /** Max agents running at once within a parallel step. */
  maxConcurrency?: number;
  /** Token budget for the compacted context handed to the next step. */
  resultTokenBudget?: number;
  /** Shared project index (maintained across tasks when reused). */
  projectIndex?: ProjectIndexService;
  /** Max review→fix rounds after the editor runs (default 1, 0 disables). */
  fixRounds?: number;
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

/**
 * The GRACE coordinator.
 *
 * Receives a task, plans which specialized agents are needed (and in what
 * order), executes the plan — running independent agents in parallel — and
 * composes a concise final answer from the structured results. Context between
 * steps is always compacted to a token budget; agent failures never abort the
 * run; the browser agent is reported "unavailable" rather than silently
 * broken. The coordinator NEVER sends the whole repository or conversation to
 * any agent.
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
    const { runtime } = this.deps;
    const onEvent = this.deps.onEvent;

    onEvent?.({ type: 'planning' });

    const index = this.index.get();
    const browser = browserAvailability();
    const unavailable: AgentRole[] = browser.available ? [] : ['browser-use'];
    const available = ALL_AGENT_ROLES.filter((r) => !unavailable.includes(r));

    const planner = this.deps.planner ?? llmPlanner(runtime.provider);
    const plannerInput = { task, indexSummary: index.summary, availableAgents: available, unavailableAgents: unavailable };
    let plan: AgentPlan;
    try {
      // Normalize against ALL known roles: unknown roles are dropped, but
      // unavailable roles are kept so runOne can report them cleanly.
      plan = normalizePlan(await planner(plannerInput), ALL_AGENT_ROLES);
    } catch {
      plan = normalizePlan(ruleBasedPlanner(plannerInput), ALL_AGENT_ROLES);
    }

    const acc: Accumulator = { changedFiles: new Set(), iterations: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const results: SubagentResult[] = [];

    for (let s = 0; s < plan.steps.length; s += 1) {
      const step = plan.steps[s] as AgentPlan['steps'][number];
      onEvent?.({ type: 'step-start', step: s + 1, total: plan.steps.length });
      // Narrow context: only the compacted summaries of prior steps plus the
      // repository index — never raw tool dumps or full conversations.
      const contextText = compactResults(results, this.deps.resultTokenBudget ?? DEFAULT_RESULT_BUDGET);
      this.merge(acc, results, await this.runStep(step.agents, task, contextText, index.summary, unavailable));
    }

    // Bounded review→fix loop: when the reviewer found actionable issues, the
    // editor gets one more pass with the review findings, then the test runner
    // re-verifies. Kept deliberately to one round (fixRounds) so it can never
    // loop forever.
    const fixRounds = this.deps.fixRounds ?? 1;
    for (let round = 0; round < fixRounds; round += 1) {
      const reviewer = results.find((r) => r.agent === 'code-reviewer' && r.status === 'completed');
      const editorRan = results.some((r) => r.agent === 'editor');
      const needsFix = editorRan && reviewer !== undefined && reviewer.recommendations.length > 0;
      if (!needsFix) break;
      const contextText = compactResults(results, this.deps.resultTokenBudget ?? DEFAULT_RESULT_BUDGET);
      this.merge(acc, results, await this.runStep(['editor'], `${task}\n\nAddress the review findings above.`, contextText, index.summary, unavailable));
      const testPlanned = plan.steps.some((s) => s.agents.includes('test-runner'));
      if (testPlanned) {
        const verifyCtx = compactResults(results, this.deps.resultTokenBudget ?? DEFAULT_RESULT_BUDGET);
        this.merge(acc, results, await this.runStep(['test-runner'], `${task}\n\nRe-run the relevant tests after the fix.`, verifyCtx, index.summary, unavailable));
      }
    }

    const finalAnswer = composeFinalAnswer(results, unavailable);
    onEvent?.({ type: 'done' });

    return {
      task,
      plan,
      results,
      finalAnswer,
      changedFiles: [...acc.changedFiles],
      iterations: acc.iterations,
      toolCalls: acc.toolCalls,
      usage: acc.totalTokens > 0 ? { inputTokens: acc.inputTokens, outputTokens: acc.outputTokens, totalTokens: acc.totalTokens } : undefined,
    };
  }

  /** Fold a step's results into the shared accumulator + results list. */
  private merge(acc: Accumulator, results: SubagentResult[], stepResults: SubagentResult[]): void {
    for (const r of stepResults) {
      results.push(r);
      acc.iterations += r.iterations;
      acc.toolCalls += r.toolCalls;
      if (r.usage) {
        acc.inputTokens += r.usage.inputTokens;
        acc.outputTokens += r.usage.outputTokens;
        acc.totalTokens += r.usage.totalTokens;
      }
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
  ): Promise<SubagentResult[]> {
    const cap = Math.max(1, Math.min(this.deps.maxConcurrency ?? DEFAULT_CONCURRENCY, roles.length));
    const out: SubagentResult[] = new Array<SubagentResult>(roles.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < roles.length) {
        const i = next;
        next += 1;
        out[i] = await this.runOne(roles[i] as AgentRole, task, contextText, indexSummary, unavailable);
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
  ): Promise<SubagentResult> {
    const { runtime } = this.deps;
    const spec = AGENT_SPECS[role] as AgentSpec;
    const onEvent = this.deps.onEvent;

    onEvent?.({ type: 'agent-start', role, label: spec.label });

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
      onEvent?.({ type: 'agent-done', role, label: spec.label, status: 'unavailable', summary: res.summary, error: reason });
      return res;
    }

    // Defense in depth: a read-only spec must never carry write/execute tools.
    if (spec.readOnly && !capabilitiesAreReadOnly(spec.capabilities)) {
      return this.fail(spec, 'Permission boundary violation: read-only role granted mutating tools.');
    }

    try {
      const provider = this.deps.providerFactory ? (this.deps.providerFactory(role, spec) ?? runtime.provider) : runtime.provider;
      if (!provider) return this.fail(spec, 'No AI provider is configured.');

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

      // Repo-aware roles also receive the compact index summary.
      const context = ['project-scout', 'file-picker', 'thinker', 'editor'].includes(role)
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
        },
        spec,
        task,
        context,
      );

      onEvent?.({ type: 'agent-done', role, label: spec.label, status: result.status, summary: result.summary, error: result.error });
      return result;
    } catch (err) {
      // Per-agent recovery: an unexpected crash must never abort the run.
      return this.fail(spec, `Agent crashed: ${(err as Error).message ?? String(err)}`);
    }
  }

  private fail(spec: AgentSpec, error: string): SubagentResult {
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
    this.deps.onEvent?.({ type: 'agent-done', role: spec.role, label: spec.label, status: 'failed', summary: error, error });
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
