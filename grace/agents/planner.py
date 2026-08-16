"""Task planning (port of src/agents/planner.ts).

Planning is OPTIONAL and only engaged for complex tasks. The default plan for
any coding/inspect task is a single primary-agent step — the coordinator
never plans for simple work. When planning does run, the deterministic
rule-based planner is primary (instant, zero model calls); the LLM planner is
available for deeper strategy and falls back to the rules on any failure.
"""

import json
import re

from grace.agents.compact import compact_text
from grace.agents.structured import extract_last_json_object
from grace.agents.types import AgentPlan, PlanStep

DEFAULT_PRIMARY_PLAN = AgentPlan(
    steps=[PlanStep(agents=["editor"], reason="Primary agent handles the task directly.")],
    notes="primary-agent",
)


def normalize_plan(plan: AgentPlan, known_roles: list[str]) -> AgentPlan:
    """Cap the plan size and enforce dependency invariants (the editor runs alone)."""
    steps: list[PlanStep] = []
    for step in plan.steps[:8]:
        if not isinstance(step.agents, list) or len(step.agents) == 0:
            continue
        agents: list[str] = []
        for a in step.agents:
            if a in known_roles and a not in agents:
                agents.append(a)
        if not agents:
            continue
        if "editor" in agents and len(agents) > 1:
            # The primary agent is the worker — never parallelized with others.
            steps.append(PlanStep(agents=[a for a in agents if a != "editor"], reason=step.reason))
            steps.append(PlanStep(agents=["editor"], reason="Primary agent executes the plan."))
        else:
            steps.append(PlanStep(agents=agents, reason=step.reason))
    return AgentPlan(steps=steps, notes=plan.notes) if steps else DEFAULT_PRIMARY_PLAN


def rule_based_planner(input_info) -> AgentPlan:
    """Deterministic plan used for complex tasks. Deliberately lean."""
    t = input_info.task.strip()

    if re.match(r"^(git|commit|stage|stash|rebase|merge|branch|log)\b", t, re.I) or re.match(r"^(what\s+changed|show\s+git)", t, re.I):
        return AgentPlan(steps=[PlanStep(agents=["git-curator"], reason="Git operation.")])

    if re.match(r"^(run|execute)\s+(the\s+)?(tests?|test\s+suite|typecheck|lint|build|smoke)\b", t, re.I) or re.match(r"^are\s+the\s+tests", t, re.I):
        return AgentPlan(steps=[PlanStep(agents=["test-runner"], reason="Run the tests.")])

    if re.search(r"\b(research|how\s+to\s+integrate|api\s+docs|official\s+docs)\b", t, re.I):
        return AgentPlan(steps=[
            PlanStep(agents=["researcher"], reason="External research."),
            PlanStep(agents=["editor"], reason="Primary agent applies the findings."),
        ])

    if re.search(r"(website|web\s*page|web\s+app|browser|playwright|puppeteer|looks?\s+broken)", t, re.I):
        return AgentPlan(steps=[PlanStep(agents=["browser-use"], reason="Verify rendering in the browser.")])

    # Complex/architectural work: an optional strategy specialist first, then
    # the primary agent executes.
    complex_task = bool(re.search(r"complex|architecture|design|concurrency|performance|security|refactor|hard|difficult|trade-?offs", t, re.I))
    if complex_task:
        return AgentPlan(steps=[
            PlanStep(agents=["thinker"], reason="Optional strategy specialist: design the implementation approach."),
            PlanStep(agents=["editor"], reason="Primary agent executes the plan."),
        ])

    return DEFAULT_PRIMARY_PLAN


PLANNER_SYSTEM = "\n".join([
    "You are the GRACE planner for complex tasks. Decide which specialized agents should work on the task and in what order.",
    "Rules:",
    "- Use as few agents as possible; the primary agent (editor) handles most of the work itself.",
    "- The editor is the primary worker and must run alone in its own step.",
    "- Optional specialists that may run BEFORE the editor when they add clear value: thinker (strategy), researcher (web research), project-scout (map the repo).",
    "- Never include file-picker, code-reviewer or test-runner — the primary agent searches, reviews and validates itself.",
    "- Only use the listed available agents.",
    'Reply with ONLY a JSON object, no prose and no markdown fences:',
    '{"steps":[{"agents":["thinker"],"reason":"short justification"},{"agents":["editor"],"reason":"implement"}],"notes":"optional one-liner"}',
])

ROLE_PURPOSES = {
    "project-scout": "structural map of the repository",
    "file-picker": "find and rank relevant files",
    "thinker": "deep technical reasoning / strategy",
    "researcher": "external docs/web research",
    "code-reviewer": "review changes for bugs/regressions/security",
    "test-runner": "run the relevant tests",
    "shell-runner": "execute shell commands safely",
    "git-curator": "git inspect/stage/commit (authorized only)",
    "browser-use": "browser verification",
    "editor": "the primary coding agent (implements)",
}


def _build_planner_prompt(input_info) -> str:
    roles = "\n".join(f"- {r}: {ROLE_PURPOSES.get(r, '')}" for r in input_info.availableAgents)
    parts = [
        f"Task: {input_info.task}",
        "",
        "Repository index:",
        compact_text(input_info.indexSummary, 1_500),
        "",
        "Available agents:",
        roles,
    ]
    if input_info.unavailableAgents:
        parts.append(f"\nUnavailable (do not use): {', '.join(input_info.unavailableAgents)}")
    return "\n".join(p for p in parts if p)


def parse_plan(raw: str, available: list[str]) -> AgentPlan | None:
    json_text = extract_last_json_object(raw)
    if not json_text:
        return None
    try:
        parsed = json.loads(json_text)
    except Exception:
        return None
    if not isinstance(parsed, dict) or not isinstance(parsed.get("steps"), list) or not parsed["steps"]:
        return None
    plan = AgentPlan(steps=[])
    for step in parsed["steps"][:8]:
        if not isinstance(step, dict) or not isinstance(step.get("agents"), list) or not step["agents"]:
            continue
        agents = [a for a in step["agents"] if isinstance(a, str) and a in available]
        if not agents:
            continue
        plan.steps.append(PlanStep(agents=agents, reason=step.get("reason") if isinstance(step.get("reason"), str) else ""))
    return normalize_plan(plan, available) if plan.steps else None


def llm_planner(provider):
    """LLM-backed planner that falls back to the rule-based plan on any failure."""

    def plan(input_info) -> AgentPlan:
        if provider is None:
            return rule_based_planner(input_info)
        try:
            messages = [
                {"role": "system", "content": PLANNER_SYSTEM},
                {"role": "user", "content": _build_planner_prompt(input_info)},
            ]
            res = provider.chat(messages, {"temperature": 0, "maxTokens": 600})
            parsed = parse_plan(res.content or "", input_info.availableAgents)
            if parsed:
                return parsed
        except Exception:
            pass
        return rule_based_planner(input_info)

    return plan
