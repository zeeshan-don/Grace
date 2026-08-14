/**
 * Fast local router (GRACE primary-agent redesign).
 *
 * Before ANY model call, the coordinator classifies the user's input with
 * deterministic logic — no LLM is spent deciding which LLM should run:
 *
 *   - conversation → answered locally, zero model calls, zero tools,
 *     zero repository scanning (greetings, thanks, "what can you do?").
 *   - tests       → deterministic test runner, zero model calls.
 *   - complex     → the only route eligible for a planning phase + optional
 *                   specialist subagents (architecture / redesign / build).
 *   - inspect     → the primary agent answers with read-only investigation
 *                   (explain / what / why / how questions). Same agent loop,
 *                   it simply ends up reading instead of editing.
 *   - coding      → the default: the primary agent starts immediately.
 *
 * The primary agent is the default execution path. Complex tasks may plan,
 * but the classification itself is always local and instant.
 */

export type TaskRoute = 'conversation' | 'tests' | 'complex' | 'inspect' | 'coding';

export interface Classification {
  route: TaskRoute;
}

const CONVERSATION_RE =
  /^(hi\b|hii+|hello|hey|yo|sup|good\s*(morning|afternoon|evening)|thanks|thank\s*you|thx|ty\b|bye|goodbye|see\s*ya|cya|what\s+can\s+you\s+do|what\s+are\s+you\b|who\s+are\s+you\b|are\s+you\s+there)/i;

const TESTS_RE =
  /^(run|execute|start|are|do|is|check)\b.*\b(tests?|test\s+suite|typecheck|lint|build|smoke)\b|^(are|is)\s+the\s+(tests?|build|typecheck|lint)/i;

/** Browser-verification requests engage the plan path so the browser specialist can report availability. */
const BROWSER_RE = /(website|web\s*page|web\s+app|browser|playwright|puppeteer|looks?\s+broken)/i;

/**
 * Complex-task markers: broad architectural verbs, or concrete "build X"
 * phrasing for systems-sized subjects. Only these are eligible for planning.
 */
const COMPLEX_VERB_RE =
  /\b(complex|complicated|architecture|architectural|redesign|overhaul|refactor|rewrite|migrate|migration|convert|conversion|design|designing|restructure|restructuring)\b/i;
const COMPLEX_BUILD_RE =
  /\b(build|create|implement|add|set\s+up|design)\b.*\b(authentication|auth\b|database|db\b|architecture|system|microservice|api\b|endpoint|payment|billing|subscription|multi-?tenant|oauth|jwt|graphql|backend|frontend|pipeline|ci\/?cd|monorepo)\b/i;

const INSPECT_RE =
  /^(explain|what|why|how|where|who|which|describe|summarize|show|outline|find|list|is\s+there|does\b)\b/i;

/** Deterministic, instant classification — never calls a model. */
export function classifyTask(input: string): Classification {
  const t = input.trim();
  if (CONVERSATION_RE.test(t)) return { route: 'conversation' };
  // "run the tests and fix failures" is a coding task — the primary agent
  // runs the tests and fixes what breaks. Pure test runs stay deterministic.
  if (TESTS_RE.test(t) && !/\b(fix|repair|failing|broken|debug)\b/i.test(t)) return { route: 'tests' };
  if (BROWSER_RE.test(t)) return { route: 'complex' }; // eligible for planning → browser specialist
  if (COMPLEX_VERB_RE.test(t) || COMPLEX_BUILD_RE.test(t)) return { route: 'complex' };
  if (INSPECT_RE.test(t)) return { route: 'inspect' };
  return { route: 'coding' };
}

/**
 * Local reply for the conversation route. Zero model calls, zero tools.
 * Falls back to a generic prompt when the pattern is not recognized.
 */
export function conversationReply(input: string): string {
  const t = input.trim().toLowerCase();
  if (/^(hi\b|hii+|hello|hey|yo|sup|good\s*(morning|afternoon|evening))\b/.test(t)) {
    return 'Hey. What are we building?';
  }
  if (/^(thanks|thank\s*you|thx|ty)\b/.test(t)) {
    return 'Anytime. What are we working on next?';
  }
  if (/^(bye|goodbye|see\s*ya|cya)\b/.test(t)) {
    return 'See you around. /exit quits whenever you are ready.';
  }
  if (/what\s+can\s+you\s+do|what\s+are\s+you\b|who\s+are\s+you\b|are\s+you\s+there/.test(t)) {
    return (
      'I am GRACE, a coding agent that works inside this repository.\n' +
      'Ask me to fix a bug, add a feature, explain code, run tests, or redesign a system — for example:\n' +
      '  "what does src/ do?" · "fix the TypeScript error" · "build authentication"'
    );
  }
  return 'Hey. What are we building?';
}
