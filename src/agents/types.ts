/**
 * Subagent coordinator types (GRACE coordinator).
 *
 * The coordinator decomposes a user task into a small plan of specialized
 * agents. Each agent gets narrow context, a restricted tool set and explicit
 * permissions, then reports a compact structured result back to the
 * coordinator. This keeps every model call small and prevents the TPM/context
 * blowups of a single unbounded loop.
 */

/** The specialized agent roles the coordinator can delegate to. */
export type AgentRole =
  | 'project-scout'
  | 'file-picker'
  | 'thinker'
  | 'researcher'
  | 'code-reviewer'
  | 'test-runner'
  | 'shell-runner'
  | 'git-curator'
  | 'browser-use'
  | 'editor';

/**
 * What an agent is allowed to touch. The coordinator maps capabilities to the
 * actual tool set (see capabilities.ts) — an agent can never call a tool
 * outside its capability set, regardless of what the model asks for.
 */
export type Capability = 'read' | 'write' | 'execute' | 'diff' | 'web' | 'browser';

/** Model selection hint; the ModelRouter maps tiers to concrete model ids. */
export type ModelTier = 'fast' | 'default' | 'strong';

export interface AgentSpec {
  role: AgentRole;
  /** Human label for progress lines, e.g. "Project Scout". */
  label: string;
  /** One-line purpose used by the planner. */
  purpose: string;
  /** Role instructions injected as the system prompt. */
  systemPrompt: string;
  capabilities: Capability[];
  /** Read-only agents have no write or execute tools, ever. */
  readOnly: boolean;
  modelTier: ModelTier;
  maxIterations: number;
  contextBudget: number;
  /** Whether the agent must end with a structured JSON result block. */
  structured: boolean;
}

/** Compact structured result every agent reports back to the coordinator. */
export interface SubagentResult {
  agent: AgentRole;
  label: string;
  status: 'completed' | 'failed' | 'skipped' | 'unavailable';
  /** Concise user-facing summary (the coordinator surfaces this). */
  summary: string;
  /** Relevant/visited files (relative paths, deduped). */
  files: string[];
  /** Files actually modified by the agent (empty for read-only roles). */
  changedFiles: string[];
  findings: string[];
  recommendations: string[];
  error?: string;
  iterations: number;
  toolCalls: number;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/** One plan step: agents that may run in parallel. */
export interface PlanStep {
  agents: AgentRole[];
  reason: string;
}

export interface AgentPlan {
  steps: PlanStep[];
  notes?: string;
}

export interface PlannerInput {
  task: string;
  /** Compact structural summary of the repository (project index). */
  indexSummary: string;
  availableAgents: AgentRole[];
  unavailableAgents: AgentRole[];
}

export type Planner = (input: PlannerInput) => Promise<AgentPlan>;

export type CoordinatorEvent =
  | { type: 'planning' }
  | { type: 'step-start'; step: number; total: number }
  | { type: 'agent-start'; role: AgentRole; label: string }
  | { type: 'agent-done'; role: AgentRole; label: string; status: SubagentResult['status']; summary: string; error?: string }
  | { type: 'done' };

export interface CoordinatorRunResult {
  task: string;
  plan: AgentPlan;
  results: SubagentResult[];
  /** Composed final answer shown to the user. */
  finalAnswer: string;
  changedFiles: string[];
  iterations: number;
  toolCalls: number;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}
