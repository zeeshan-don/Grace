"""Fast local router (port of src/agents/fastRouter.ts).

Before ANY model call, the coordinator classifies the user's input with
deterministic logic — no LLM is spent deciding which LLM should run:
  - conversation → answered locally, zero model calls.
  - tests       → deterministic test runner, zero model calls.
  - complex     → eligible for a planning phase + optional specialists.
  - inspect     → read-only investigation by the primary agent.
  - coding      → the default: the primary agent starts immediately.
"""

import re

CONVERSATION_RE = re.compile(
    r"^(hi\b|hii+|hello|hey|yo|sup|good\s*(morning|afternoon|evening)|thanks|thank\s*you|thx|ty\b|bye|goodbye|see\s*ya|cya|what\s+can\s+you\s+do|what\s+are\s+you\b|who\s+are\s+you\b|are\s+you\s+there|what\s+is\s+your\s+name|tell\s+me\s+about\s+yourself|introduce\s+yourself|what\s+do\s+you\s+call\s+yourself)",
    re.I,
)

TESTS_RE = re.compile(
    r"^(run|execute|start|are|do|is|check)\b.*\b(tests?|test\s+suite|typecheck|lint|build|smoke)\b|^(are|is)\s+the\s+(tests?|build|typecheck|lint)",
    re.I,
)

# Browser-verification requests engage the plan path so the browser specialist can report availability.
BROWSER_RE = re.compile(r"(website|web\s*page|web\s+app|browser|playwright|puppeteer|looks?\s+broken)", re.I)

COMPLEX_VERB_RE = re.compile(
    r"\b(complex|complicated|architecture|architectural|redesign|overhaul|refactor|rewrite|migrate|migration|convert|conversion|design|designing|restructure|restructuring)\b",
    re.I,
)
COMPLEX_BUILD_RE = re.compile(
    r"\b(build|create|implement|add|set\s+up|design)\b.*\b(authentication|auth\b|database|db\b|architecture|system|microservice|api\b|endpoint|payment|billing|subscription|multi-?tenant|oauth|jwt|graphql|backend|frontend|pipeline|ci\/?cd|monorepo)\b",
    re.I,
)

INSPECT_RE = re.compile(r"^(explain|what|why|how|where|who|which|describe|summarize|show|outline|find|list|is\s+there|does\b)\b", re.I)


def classify_task(input_text: str) -> str:
    """Deterministic, instant classification — never calls a model."""
    t = input_text.strip()
    if CONVERSATION_RE.search(t):
        return "conversation"
    # "run the tests and fix failures" is a coding task — the primary agent
    # runs the tests and fixes what breaks. Pure test runs stay deterministic.
    if TESTS_RE.search(t) and not re.search(r"\b(fix|repair|failing|broken|debug)\b", t, re.I):
        return "tests"
    if BROWSER_RE.search(t):
        return "complex"
    if COMPLEX_VERB_RE.search(t) or COMPLEX_BUILD_RE.search(t):
        return "complex"
    if INSPECT_RE.search(t):
        return "inspect"
    return "coding"


def conversation_reply(input_text: str) -> str:
    """Local reply for the conversation route. Zero model calls, zero tools."""
    t = input_text.strip().lower()
    if re.match(r"^(hi\b|hii+|hello|hey|yo|sup|good\s*(morning|afternoon|evening))\b", t):
        return "Hey. What are we building?"
    if re.match(r"^(thanks|thank\s*you|thx|ty)\b", t):
        return "Anytime. What are we working on next?"
    if re.match(r"^(bye|goodbye|see\s*ya|cya)\b", t):
        return "See you around. /exit quits whenever you are ready."
    if re.search(r"what\s+can\s+you\s+do|what\s+are\s+you\b|who\s+are\s+you\b|are\s+you\s+there|what\s+is\s+your\s+name|tell\s+me\s+about\s+yourself|introduce\s+yourself|what\s+do\s+you\s+call\s+yourself", t):
        return (
            "I am GRACE, an AI coding agent built by Zeesh Studios.\n"
            "I work inside this repository to help you fix bugs, add features, explain code, run tests, or redesign systems.\n"
            'Try: "what does src/ do?" · "fix the TypeScript error" · "build authentication"'
        )
    return "Hey. What are we building?"
