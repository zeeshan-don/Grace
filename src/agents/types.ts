/**
 * Agent types (GRACE primary-agent architecture).
 *
 * The coordinator classifies each task with the fast local router, then by
 * default runs ONE primary agent (the editor) with the full toolset. Planning
 * and specialized subagents are optional — they are only engaged for complex
 * tasks or when the user explicitly asks (e.g. a review).
 */

import type { Usage } from '../providers/types.ts';

/** Deterministic classification produced by the fast router (no LLM). */
export type TaskRoute = 'conversation' | 'tests' | 'complex' | 'inspect' | 'coding';

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

/**
 * Model selection hint; the ModelRouter maps tiers to concrete model ids
 * (see src/agents/modelRouter.ts). `no_llm` roles run deterministically and
 * must never consume a model request.
 */
export type ModelTier = 'fast' | 'coding' | 'reasoning' | 'review' | 'no_llm';

export interface AgentSpec {
  role: AgentRole;
  /** Human label for progress lines, e.g. "Grace". */
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
  usage?: Usage;
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

/**
 * Coordinator progress events — never chain-of-thought. The CLI renders
 * high-level state only: which route was chosen, concise progress bullets,
 * and agent summaries.
 */
export type CoordinatorEvent =
  | { type: 'route'; route: TaskRoute }
  | { type: 'planning' }
  /** The primary agent is working (live spinner in TTY mode). */
  | { type: 'working' }
  /** A concise, settled progress bullet, e.g. "Exploring the project". */
  | { type: 'status'; message: string }
  | { type: 'step-start'; step: number; total: number }
  | { type: 'agent-start'; role: AgentRole; label: string }
  | { type: 'agent-done'; role: AgentRole; label: string; status: SubagentResult['status']; summary: string; error?: string }
  | { type: 'done' };

/** Performance instrumentation for one run (spec: measure + log). */
export interface RunMetrics {
  /** Total model requests across every agent + optional planning call. */
  llmCalls: number;
  /** Milliseconds until the first progress/tool signal from the primary agent. */
  timeToFirstResponseMs?: number;
  /** Milliseconds until the primary agent's first tool execution. */
  timeToFirstToolCallMs?: number;
}

export interface CoordinatorRunResult {
  task: string;
  /** How the fast router classified the task. */
  route: TaskRoute;
  plan: AgentPlan;
  results: SubagentResult[];
  /** Composed final answer shown to the user. */
  finalAnswer: string;
  changedFiles: string[];
  iterations: number;
  toolCalls: number;
  usage?: Usage;
  metrics: RunMetrics;
}
