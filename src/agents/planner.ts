import type { AIProvider, ChatMessage } from '../providers/types.ts';
import { compactText } from './compact.ts';
import { extractLastJsonObject } from './structured.ts';
import type { AgentPlan, AgentRole, Planner, PlannerInput, PlanStep } from './types.ts';

/**
 * Task planning (GRACE primary-agent architecture).
 *
 * Planning is OPTIONAL and only engaged for complex tasks. The default plan
 * for any coding/inspect task is a single primary-agent step — the coordinator
 * never plans for simple work. When planning does run, the deterministic
 * rule-based planner is primary (instant, zero model calls); the LLM planner
 * is available for deeper strategy and falls back to the rules on any failure.
 */

// ---------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------

/**
 * Cap the plan size and enforce dependency invariants (the editor runs alone).
 * Unknown roles are dropped; AVAILABLE-but-unsupported roles (e.g. browser-use
 * without a browser backend) are KEPT so the coordinator reports them as
 * unavailable instead of silently substituting another agent.
 */
export function normalizePlan(plan: AgentPlan, knownRoles: AgentRole[]): AgentPlan {
  const steps: PlanStep[] = [];
  for (const step of plan.steps.slice(0, 8)) {
    if (!Array.isArray(step.agents) || step.agents.length === 0) continue;
    const agents = [...new Set(step.agents.filter((r): r is AgentRole => knownRoles.includes(r)))];
    if (agents.length === 0) continue;
    const editorIndex = agents.indexOf('editor');
    if (editorIndex !== -1 && agents.length > 1) {
      // The primary agent is the worker — never parallelized with others.
      steps.push({ agents: agents.filter((a) => a !== 'editor'), reason: step.reason });
      steps.push({ agents: ['editor'], reason: 'Primary agent executes the plan.' });
    } else {
      steps.push({ agents, reason: step.reason });
    }
  }
  return steps.length > 0 ? { steps, notes: plan.notes } : DEFAULT_PRIMARY_PLAN;
}

/** The default plan: ONE primary agent, nothing else. */
export const DEFAULT_PRIMARY_PLAN: AgentPlan = {
  steps: [{ agents: ['editor'], reason: 'Primary agent handles the task directly.' }],
  notes: 'primary-agent',
};

// ---------------------------------------------------------------------------
// Rule-based planner (deterministic, zero model calls)
// ---------------------------------------------------------------------------

/**
 * Deterministic plan used for complex tasks. Deliberately lean: exploration
 * and review live INSIDE the primary agent's tool loop; only genuinely useful
 * specialists appear (strategy for architecture work, git for git operations,
 * browser for browser verification).
 */
export function ruleBasedPlanner(input: PlannerInput): AgentPlan {
  const t = input.task.trim();

  if (/^(git|commit|stage|stash|rebase|merge|branch|log)\b/i.test(t) || /^(what\s+changed|show\s+git)/i.test(t)) {
    return { steps: [{ agents: ['git-curator'], reason: 'Git operation.' }] };
  }

  if (/^(run|execute)\s+(the\s+)?(tests?|test\s+suite|typecheck|lint|build|smoke)\b/i.test(t) || /^are\s+the\s+tests/i.test(t)) {
    return { steps: [{ agents: ['test-runner'], reason: 'Run the tests.' }] };
  }

  if (/\b(research|how\s+to\s+integrate|api\s+docs|official\s+docs)\b/i.test(t)) {
    return {
      steps: [
        { agents: ['researcher'], reason: 'External research.' },
        { agents: ['editor'], reason: 'Primary agent applies the findings.' },
      ],
    };
  }

  if (/(website|web\s*page|web\s+app|browser|playwright|puppeteer|looks?\s+broken)/i.test(t)) {
    return { steps: [{ agents: ['browser-use'], reason: 'Verify rendering in the browser.' }] };
  }

  // Complex/architectural work: an optional strategy specialist first, then
  // the primary agent executes. No scouts, pickers or reviewers by default.
  const complex = /complex|architecture|design|concurrency|performance|security|refactor|hard|difficult|trade-?offs/i.test(t);
  if (complex) {
    return {
      steps: [
        { agents: ['thinker'], reason: 'Optional strategy specialist: design the implementation approach.' },
        { agents: ['editor'], reason: 'Primary agent executes the plan.' },
      ],
    };
  }

  // Everything else is handled directly by the primary agent.
  return DEFAULT_PRIMARY_PLAN;
}

// ---------------------------------------------------------------------------
// LLM planner (optional deep strategy; rule fallback on any failure)
// ---------------------------------------------------------------------------

const PLANNER_SYSTEM = [
  'You are the GRACE planner for complex tasks. Decide which specialized agents should work on the task and in what order.',
  'Rules:',
  '- Use as few agents as possible; the primary agent (editor) handles most of the work itself.',
  '- The editor is the primary worker and must run alone in its own step.',
  '- Optional specialists that may run BEFORE the editor when they add clear value: thinker (strategy), researcher (web research), project-scout (map the repo).',
  '- Never include file-picker, code-reviewer or test-runner — the primary agent searches, reviews and validates itself.',
  '- Only use the listed available agents.',
  'Reply with ONLY a JSON object, no prose and no markdown fences:',
  '{"steps":[{"agents":["thinker"],"reason":"short justification"},{"agents":["editor"],"reason":"implement"}],"notes":"optional one-liner"}',
].join('\n');

function buildPlannerPrompt(input: PlannerInput): string {
  const roles = input.availableAgents.map((r) => `- ${r}: ${rolePurpose(r)}`).join('\n');
  return [
    `Task: ${input.task}`,
    '',
    'Repository index:',
    compactText(input.indexSummary, 1_500),
    '',
    'Available agents:',
    roles,
    input.unavailableAgents.length > 0 ? `\nUnavailable (do not use): ${input.unavailableAgents.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function rolePurpose(role: AgentRole): string {
  switch (role) {
    case 'project-scout': return 'structural map of the repository';
    case 'file-picker': return 'find and rank relevant files';
    case 'thinker': return 'deep technical reasoning / strategy';
    case 'researcher': return 'external docs/web research';
    case 'code-reviewer': return 'review changes for bugs/regressions/security';
    case 'test-runner': return 'run the relevant tests';
    case 'shell-runner': return 'execute shell commands safely';
    case 'git-curator': return 'git inspect/stage/commit (authorized only)';
    case 'browser-use': return 'browser verification';
    case 'editor': return 'the primary coding agent (implements)';
  }
}

/** Parse a raw LLM reply into a validated plan, or null. */
export function parsePlan(raw: string, available: AgentRole[]): AgentPlan | null {
  const json = extractLastJsonObject(raw);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { steps?: Array<{ agents?: unknown; reason?: unknown }> };
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
    const plan: AgentPlan = { steps: [] };
    for (const step of parsed.steps.slice(0, 8)) {
      if (!Array.isArray(step.agents) || step.agents.length === 0) continue;
      const agents = step.agents.filter((a): a is AgentRole => typeof a === 'string' && available.includes(a as AgentRole));
      if (agents.length === 0) continue;
      plan.steps.push({ agents, reason: typeof step.reason === 'string' ? step.reason : '' });
    }
    return plan.steps.length > 0 ? normalizePlan(plan, available) : null;
  } catch {
    return null;
  }
}

/** LLM-backed planner that falls back to the rule-based plan on any failure. */
export function llmPlanner(provider: AIProvider | null): Planner {
  return async (input) => {
    if (!provider) return ruleBasedPlanner(input);
    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: PLANNER_SYSTEM },
        { role: 'user', content: buildPlannerPrompt(input) },
      ];
      const res = await provider.chat(messages, { temperature: 0, maxTokens: 600 });
      const plan = parsePlan(res.content ?? '', input.availableAgents);
      if (plan) return plan;
    } catch {
      /* fall through to the deterministic planner */
    }
    return ruleBasedPlanner(input);
  };
}
