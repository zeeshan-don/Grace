/**
 * Structured result rendering (GRACE UI).
 *
 * Turns a finished coordinator run into clearly separated sections:
 *
 *   ✓ Done
 *   Implemented dashboard authentication.
 *
 *   Files changed
 *     + src/auth/login.ts
 *     M src/auth/session.ts
 *
 *   Validation
 *     ✓ Tests — 215/215 passed
 *
 *   Provider
 *     NVIDIA NIM · qwen/qwen2.5-coder-32b-instruct
 *
 *   Time
 *     18.4s · 3 iteration(s) · 5 tool call(s)
 *
 *   Suggested follow-ups
 *     → Review the changes /diff
 *
 * Sections that carry no information are omitted. Also exports the pure
 * renderers behind /model and /status plus the long-output collapse helper.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CoordinatorRunResult, SubagentResult } from '../../agents/types.ts';
import { isGitRepo, statusShort } from '../../git/git.ts';
import { RemoteProvider } from '../../providers/remote.ts';
import type { Runtime } from '../../runtime.ts';
import { formatDuration } from '../../util/text.ts';
import { kv, section } from './box.ts';
import { symbols, theme, type Symbols, type Theme } from './theme.ts';

// ---------------------------------------------------------------------------
// Task result sections
// ---------------------------------------------------------------------------

export interface TaskResultRenderInfo {
  result: CoordinatorRunResult;
  runtime: Runtime;
  executionTimeMs: number;
  /** Extra diagnostics (plan, per-agent details, token counts). */
  verbose?: boolean;
}

/** Render the full post-task result block. */
export function renderTaskResult(info: TaskResultRenderInfo): string {
  const { result, runtime, executionTimeMs, verbose = false } = info;
  const sym = symbols();
  const th = theme();
  const parts: string[] = [];

  // Failure is decided by the PRIMARY worker (the last editor), or by a total
  // failure when no editor ran — a secondary agent (e.g. a researcher) failing
  // must not mislabel a task the editor completed.
  const editor = [...result.results].reverse().find((r) => r.agent === 'editor');
  const completedAny = result.results.some((r) => r.status === 'completed');
  const failed = editor ? editor.status === 'failed' : !completedAny && result.results.some((r) => r.status === 'failed');
  const header = failed
    ? th.error(`${sym.cross} Task not completed`)
    : th.bold(th.success(`${sym.check} Done`));
  parts.push(header);
  parts.push('');
  parts.push(result.finalAnswer.trim());
  parts.push('');

  const files = classifyFileChanges(result.changedFiles, runtime.root);
  if (files.length > 0) {
    const MAX_SHOWN = 12;
    parts.push(section('Files changed'));
    for (const f of files.slice(0, MAX_SHOWN)) {
      parts.push(`  ${statusMark(f.status, th)} ${th.path(f.path)}`);
    }
    if (files.length > MAX_SHOWN) {
      parts.push(`  ${th.dim(`${sym.ellipsis} and ${files.length - MAX_SHOWN} more (use /diff for the full list)`)}`);
    }
    parts.push('');
  }

  const validation = validationLines(result.results, runtime.root);
  if (validation.length > 0) {
    parts.push(section('Validation'));
    parts.push(...validation);
    parts.push('');
  }

  parts.push(section('Provider'));
  const served = runtime.provider instanceof RemoteProvider ? runtime.provider.serverProvider : null;
  const providerLabel = served?.label ?? runtime.provider?.label ?? 'unknown';
  const model = runtime.provider?.getModel().id ?? '—';
  parts.push(`  ${th.provider(providerLabel)} ${sym.bullet} ${th.model(model)}`);
  parts.push('');

  parts.push(section('Time'));
  const timeValue = `${th.number(formatDuration(executionTimeMs))} · ${result.iterations} iteration(s) · ${result.toolCalls} tool call(s)`;
  parts.push(`  ${timeValue}`);
  parts.push('');

  const followUps = suggestedFollowUps(info);
  if (followUps.length > 0) {
    parts.push(section('Suggested follow-ups'));
    parts.push(...followUps);
    parts.push('');
  }

  if (verbose) {
    const plan = renderPlan(result);
    if (plan) {
      parts.push(section('Plan'));
      parts.push(plan);
      parts.push('');
    }
    const details = renderAgentDetails(result.results);
    if (details.length > 0) {
      parts.push(section('Agent details'));
      parts.push(...details);
      parts.push('');
    }
    if (result.usage) {
      parts.push(section('Usage'));
      parts.push(`  ${result.usage.inputTokens} tokens in · ${result.usage.outputTokens} tokens out · ${result.usage.totalTokens} total`);
      parts.push('');
    }
  }

  return parts.join('\n').replace(/\n+$/, '');
}

/** "✓ Tests — summary" lines for the agents that actually verified the work. */
function validationLines(results: SubagentResult[], root: string): string[] {
  const sym = symbols();
  const th = theme();
  const lines: string[] = [];

  const tester = results.find((r) => r.agent === 'test-runner');
  if (tester) lines.push(agentValidationLine('Tests', tester, sym, th));

  const reviewer = results.find((r) => r.agent === 'code-reviewer');
  if (reviewer) lines.push(agentValidationLine('Review', reviewer, sym, th));

  // Git is a positive signal only — a dirty tree is expected after edits and
  // already covered by "Files changed".
  if (isGitRepo(root)) {
    const clean = statusShort(root).trim() === '';
    if (clean) lines.push(`  ${th.success(sym.check)} Git — working tree clean`);
  }
  return lines;
}

function agentValidationLine(label: string, r: SubagentResult, sym: Symbols, th: Theme): string {
  const detail = oneLiner(r.status === 'completed' ? r.summary : r.status === 'failed' ? (r.error ?? r.summary) : r.summary);
  if (r.status === 'completed') return `  ${th.success(sym.check)} ${label} — ${detail}`;
  if (r.status === 'failed') return `  ${th.error(sym.cross)} ${label} — ${detail}`;
  return `  ${th.warn(sym.warn)} ${label} — ${detail}`;
}

/** Data-driven follow-up suggestions (only when they make sense). */
function suggestedFollowUps(info: TaskResultRenderInfo): string[] {
  const sym = symbols();
  const th = theme();
  const out: string[] = [];
  if (info.result.changedFiles.length > 0) {
    out.push(`  ${sym.arrow} Review the changes ${th.command('/diff')}`);
  }
  out.push(`  ${sym.arrow} Inspect project & session state ${th.command('/status')}`);
  if (info.runtime.provider) {
    out.push(`  ${sym.arrow} Switch model ${th.command('/model')}`);
  }
  return out;
}

/** Verbose: one line per plan step, e.g. "1. project-scout → file-picker → editor". */
function renderPlan(result: CoordinatorRunResult): string {
  const sym = symbols();
  const steps = result.plan.steps
    .map((s, i) => `  ${i + 1}. ${s.agents.join(` ${sym.arrow} `)}`)
    .join('\n');
  return steps;
}

/** Verbose: per-agent summary, files and findings (never chain-of-thought). */
function renderAgentDetails(results: SubagentResult[]): string[] {
  const sym = symbols();
  const th = theme();
  const out: string[] = [];
  for (const r of results) {
    const mark =
      r.status === 'completed'
        ? th.success(sym.check)
        : r.status === 'failed'
          ? th.error(sym.cross)
          : th.warn(sym.warn);
    out.push(`  ${th.agent(r.label)} ${mark}`);
    if (r.summary) out.push(`      ${oneLiner(r.summary)}`);
    const files = r.files.slice(0, 5);
    if (files.length > 0) out.push(`      files: ${files.map((f) => th.path(f)).join(', ')}`);
    for (const f of r.findings.slice(0, 3)) out.push(`      finding: ${oneLiner(f)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// File changes
// ---------------------------------------------------------------------------

export type FileChangeStatus = 'A' | 'M' | 'D';

export interface FileChange {
  status: FileChangeStatus;
  path: string;
}

export interface ClassifyOptions {
  /** Git status provider (injectable for tests). */
  getStatus?: (root: string) => string;
  /** Whether the working directory is a git repo (injectable for tests). */
  isRepo?: (root: string) => boolean;
}

/** Parse `git status --short` output into path → status codes. */
function parseStatusShort(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of output.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    // XY path — X/Y may be spaces (" M file") — handles quoted paths too.
    const match = line.match(/^(.{1,2})\s+(.+)$/);
    if (!match) continue;
    const codes = match[1]?.trim();
    const path = match[2]?.replace(/^"|"$/g, '');
    if (codes === undefined || path === undefined) continue;
    map.set(path, codes);
  }
  return map;
}

/**
 * Classify the agent's changed files with git status markers:
 * '+' added, 'M' modified, '-' deleted. Without git, creations default to '+'.
 */
export function classifyFileChanges(
  changedFiles: string[],
  root: string,
  opts: ClassifyOptions = {},
): FileChange[] {
  const isRepo = (opts.isRepo ?? isGitRepo)(root);
  const status = isRepo ? parseStatusShort((opts.getStatus ?? statusShort)(root)) : new Map<string, string>();

  return changedFiles.map((path) => {
    const codes = status.get(path);
    let s: FileChangeStatus;
    if (codes == null) {
      // Tracked in the agent's list but invisible to git: deleted, or no git.
      s = isRepo ? (existsSync(join(root, path)) ? 'M' : 'D') : 'A';
    } else if (codes.includes('D')) {
      s = 'D';
    } else if (codes.includes('A') || codes === '??') {
      s = 'A';
    } else {
      s = 'M';
    }
    return { status: s, path };
  });
}

function statusMark(status: FileChangeStatus, th: Theme): string {
  if (status === 'A') return th.success('+');
  if (status === 'D') return th.error('-');
  return th.warn('M');
}

// ---------------------------------------------------------------------------
// Errors & long output
// ---------------------------------------------------------------------------

/** Concise, secret-safe error block. */
export function renderError(message: string, hint?: string): string {
  const sym = symbols();
  const th = theme();
  const lines = [`${th.error(`${sym.cross} ${message}`)}`];
  if (hint) lines.push(`  ${th.dim(hint)}`);
  return lines.join('\n');
}

export interface CollapseOptions {
  /** Max lines shown in normal mode (verbose shows up to 500). */
  max?: number;
  /** Use verbose limits. */
  verbose?: boolean;
}

/**
 * Indent long command output and hide the tail behind a notice:
 *
 *   Command output
 *     142 lines
 *
 *     ...first lines...
 *     ...
 *     [122 line(s) hidden — use /verbose to show]
 */
export function collapseLines(input: string, opts: CollapseOptions = {}): string {
  const max = opts.verbose ? 500 : (opts.max ?? 40);
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  if (lines.length <= max) return lines.map((l) => `  ${l}`).join('\n');
  const sym = symbols();
  const th = theme();
  const head = lines.slice(0, Math.max(0, max - 2));
  const hidden = lines.length - head.length;
  return [
    ...head.map((l) => `  ${l}`),
    `  ${sym.ellipsis}`,
    `  ${th.dim(`[${hidden} line(s) hidden — use /verbose to show]`)}`,
  ].join('\n');
}

/** Render a "N lines" count line, e.g. "Command output 142 lines". */
export function outputCountLine(label: string, lines: number): string {
  const th = theme();
  return `  ${th.label(label)} ${th.number(String(lines))} ${lines === 1 ? 'line' : 'lines'}`;
}

// ---------------------------------------------------------------------------
// /model and /status panels
// ---------------------------------------------------------------------------

export interface ModelPanelInfo {
  /** Provider that actually serves requests (may differ from the transport). */
  providerLabel: string;
  /** e.g. "GRACE backend" when proxying through the backend. */
  servedVia?: string;
  model: string;
  contextWindow: number;
  providerAvailable: boolean;
  providerError?: string | null;
}

/** Structured /model output. */
export function renderModelPanel(info: ModelPanelInfo): string {
  const sym = symbols();
  const th = theme();
  const out: string[] = [];
  if (!info.providerAvailable) {
    out.push(section('Provider'));
    out.push(`  ${th.error(`${sym.cross} ${info.providerError ?? 'not configured'}`)}`);
    return out.join('\n');
  }
  out.push(section('Provider'));
  out.push(`  ${th.provider(info.providerLabel)} ${th.success(sym.check)}`);
  out.push(section('Model'));
  out.push(`  ${th.model(info.model)}`);
  out.push(section('Context'));
  out.push(`  ~${th.number(String(Math.round(info.contextWindow / 1000)))}k tokens`);
  if (info.servedVia) {
    out.push(section('Served via'));
    out.push(`  ${th.provider(info.servedVia)}`);
  }
  return out.join('\n');
}

export interface StatusPanelInfo {
  project: {
    directory: string;
    type: string;
    packageManager: string;
    languages: string[];
    configFiles: string[];
    testCommand?: string;
    buildCommand?: string;
  };
  git: {
    isRepo: boolean;
    branch: string | null;
    hasChanges: boolean;
    statusLines: number;
  };
  provider: {
    available: boolean;
    error: string | null;
    label: string;
    servedVia?: string | null;
    model: string;
    contextWindow: number;
  };
  session: {
    messages: number;
    toolCalls: number;
    runs: number;
    inputTokens: number;
    outputTokens: number;
    undoSnapshots: number;
  };
  /** Pre-rendered GRACE FREE lines (may be empty). */
  freePlan: string[];
  runtime: {
    node: string;
    platform: string;
    stateDir: string;
  };
}

/** Structured /status output. */
export function renderStatusPanel(info: StatusPanelInfo): string {
  const sym = symbols();
  const th = theme();
  const { project, git, provider, session, freePlan, runtime } = info;
  const out: string[] = [];

  const PAD = 14; // room for "Tokens in/out" and "Working tree" labels
  out.push(section('Project'));
  out.push(kv('Directory', th.path(project.directory), PAD));
  out.push(kv('Type', project.type, PAD));
  out.push(kv('Package mgr', project.packageManager, PAD));
  out.push(kv('Languages', project.languages.join(', ') || '—', PAD));
  if (project.configFiles.length) out.push(kv('Config', project.configFiles.slice(0, 10).join(', '), PAD));
  if (project.testCommand || project.buildCommand) {
    out.push(kv('Test/build', [project.testCommand, project.buildCommand].filter(Boolean).join(' · '), PAD));
  }

  out.push(section('Git'));
  if (!git.isRepo) {
    out.push('  Not a git repository');
  } else {
    out.push(kv('Branch', git.branch ?? '(detached)', PAD));
    out.push(kv('Working tree', git.hasChanges ? th.warn(`${git.statusLines} change(s)`) : th.success(`clean ${sym.check}`), PAD));
  }

  out.push(section('Model'));
  if (provider.available) {
    out.push(kv('Provider', `${th.provider(provider.label)} ${th.success(sym.check)}`, PAD));
    out.push(kv('Model', th.model(provider.model), PAD));
    if (provider.servedVia) out.push(kv('Served via', th.provider(provider.servedVia), PAD));
    out.push(kv('Context', `~${th.number(String(Math.round(provider.contextWindow / 1000)))}k tokens`, PAD));
  } else {
    const errText = provider.error ?? 'not configured';
    const shortErr = errText.length > 58 ? `${errText.slice(0, 55)}${sym.ellipsis}` : errText;
    out.push(kv('Provider', th.error(shortErr), PAD));
  }

  out.push(section('Session'));
  out.push(kv('Messages', String(session.messages), PAD));
  out.push(kv('Tool calls', String(session.toolCalls), PAD));
  out.push(kv('Runs', String(session.runs), PAD));
  out.push(kv('Tokens in/out', `${session.inputTokens} / ${session.outputTokens}`, PAD));
  out.push(kv('Undo stack', `${session.undoSnapshots} snapshot(s)`, PAD));

  if (freePlan.length > 0) {
    out.push(section('Free plan'));
    out.push(...freePlan);
  }

  out.push(section('Runtime'));
  out.push(kv('Node', runtime.node, PAD));
  out.push(kv('Platform', runtime.platform, PAD));
  out.push(kv('State dir', th.path(runtime.stateDir), PAD));

  return out.join('\n');
}

/** Collapse a multi-line string to one line (shared with progress). */
export function oneLiner(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
}
