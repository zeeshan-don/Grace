import type { AIProvider, ChatMessage } from '../providers/types.ts';
import { compactText } from './compact.ts';
import { extractLastJsonObject } from './structured.ts';
import type { AgentPlan, AgentRole, Planner, PlannerInput, PlanStep } from './types.ts';

/**
 * Task planning (ZEESH coordinator).
 *
 * The planner decides WHICH agents run, in WHAT order, and WHAT can run in
 * parallel. The LLM planner is used when a provider is available; the
 * rule-based fallback (below) is deterministic, so the coordinator always
 * produces a valid plan even when the model is down or unparseable (e.g. the
 * scripted test backend).
 */

// ---------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------

/**
 * Cap the plan size and enforce dependency invariants (editor runs alone).
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
      // The editor is the primary worker — never parallelized with others.
      steps.push({ agents: agents.filter((a) => a !== 'editor'), reason: step.reason });
      steps.push({ agents: ['editor'], reason: 'Primary implementation agent.' });
    } else {
      steps.push({ agents, reason: step.reason });
    }
  }
  return steps.length > 0 ? { steps, notes: plan.notes } : fallbackPlanInternal(knownRoles.length > 0 ? knownRoles : ['editor']);
}

function fallbackPlanInternal(_knownRoles: AgentRole[]): AgentPlan {
  return {
    steps: [{ agents: ['editor'], reason: 'Fallback: single-agent run.' }],
    notes: 'planner-fallback',
  };
}

// ---------------------------------------------------------------------------
// Rule-based fallback planner
// ---------------------------------------------------------------------------

/** Deterministic classification used when the LLM planner is unavailable. */
export function ruleBasedPlanner(input: PlannerInput): AgentPlan {
  const t = input.task.trim();

  if (/(website|web\s*page|web\s+app|browser|playwright|puppeteer|looks?\s+broken)/i.test(t)) {
    return {
      steps: [
        { agents: ['project-scout'], reason: 'Understand the project.' },
        { agents: ['browser-use'], reason: 'Verify rendering in the browser.' },
      ],
    };
  }

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
        { agents: ['thinker'], reason: 'Synthesize the research into a strategy.' },
      ],
    };
  }

  const informational = /^(explain|what\s+is|what\s+are|where\s+is|where\s+are|how\s+does|how\s+is|why\s+is|why\s+does|summarize|show|describe|outline|find|list|which)\b/i.test(t);
  if (informational) {
    const fileish = /\/[^/\s]+$/.test(t) || (/\.[a-z0-9]{1,5}\b/i.test(t) && !/\s/.test(t));
    return {
      steps: fileish
        ? [{ agents: ['file-picker'], reason: 'Read and explain the referenced file.' }]
        : [
            { agents: ['project-scout'], reason: 'Locate where the subject lives.' },
            { agents: ['file-picker'], reason: 'Pick the relevant files.' },
          ],
    };
  }

  // Default: a coding/action task follows the full lifecycle.
  const complex = /complex|architecture|design|concurrency|performance|security|refactor|hard|difficult|trade-?offs/i.test(t);
  const steps: PlanStep[] = [
    { agents: ['project-scout'], reason: 'Map the repository.' },
    { agents: ['file-picker'], reason: 'Find the relevant files.' },
  ];
  if (complex) steps.push({ agents: ['thinker'], reason: 'Design the implementation strategy.' });
  steps.push({ agents: ['editor'], reason: 'Implement the change.' });
  steps.push({ agents: ['test-runner', 'code-reviewer'], reason: 'Verify and review in parallel.' });
  return { steps };
}

// ---------------------------------------------------------------------------
// LLM planner
// ---------------------------------------------------------------------------

const PLANNER_SYSTEM = [
  'You are the ZEESH coordinator planner. Decide which specialized agents should work on the task and in what order.',
  'Rules:',
  '- Use as few agents as possible; simple tasks get one agent.',
  '- Order is sequential: exploration (project-scout, file-picker, thinker, researcher) before the editor, editor before verification.',
  '- Agents listed in the same step run in PARALLEL. Only independent agents may share a step.',
  '- The editor must run alone in its own step. test-runner and code-reviewer may share the final step.',
  '- Only use the listed available agents.',
  'Reply with ONLY a JSON object, no prose and no markdown fences:',
  '{"steps":[{"agents":["file-picker"],"reason":"short justification"}],"notes":"optional one-liner"}',
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
