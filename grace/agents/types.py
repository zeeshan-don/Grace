"""Agent types (port of src/agents/types.ts)."""

from dataclasses import dataclass, field

# Deterministic classification produced by the fast router (no LLM).
TASK_ROUTES = ("conversation", "tests", "complex", "inspect", "coding")

# The specialized agent roles the coordinator can delegate to.
AGENT_ROLES = (
    "project-scout",
    "file-picker",
    "thinker",
    "researcher",
    "code-reviewer",
    "test-runner",
    "shell-runner",
    "git-curator",
    "browser-use",
    "editor",
)

# What an agent is allowed to touch.
CAPABILITIES = ("read", "write", "execute", "diff", "web", "browser")

# Model selection hint; the ModelRouter maps tiers to concrete model ids.
MODEL_TIERS = ("fast", "coding", "reasoning", "review", "no_llm")


@dataclass
class AgentSpec:
    role: str
    label: str
    purpose: str
    systemPrompt: str
    capabilities: list[str] = field(default_factory=lambda: ["read"])
    readOnly: bool = True
    modelTier: str = "fast"
    maxIterations: int = 6
    contextBudget: int = 8_000
    structured: bool = True


@dataclass
class PlanStep:
    agents: list[str]
    reason: str


@dataclass
class AgentPlan:
    steps: list[PlanStep] = field(default_factory=list)
    notes: str | None = None


@dataclass
class SubagentResult:
    agent: str
    label: str
    status: str  # 'completed' | 'failed' | 'skipped' | 'unavailable'
    summary: str
    files: list[str] = field(default_factory=list)
    changedFiles: list[str] = field(default_factory=list)
    findings: list[str] = field(default_factory=list)
    recommendations: list[str] = field(default_factory=list)
    error: str | None = None
    failure: dict | None = None
    metrics: dict = field(default_factory=dict)
    iterations: int = 0
    toolCalls: int = 0
    usage: dict | None = None


@dataclass
class CoordinatorRunResult:
    task: str
    route: str
    plan: AgentPlan
    results: list[SubagentResult]
    finalAnswer: str
    changedFiles: list[str]
    iterations: int
    toolCalls: int
    usage: dict | None
    metrics: dict
