import { homedir } from 'node:os';
import { ApiClient } from '../auth/client.ts';
import { loadSession } from '../auth/session.ts';
import { groqApiKey, loadAppConfig, saveAppConfig, DEFAULT_MODELS } from '../config/config.ts';
import { pickModelForProvider } from '../agents/modelRouter.ts';
import { diffStat, diffUnified, gitSummary, statusShort } from '../git/git.ts';
import { projectLabel } from '../project/detect.ts';
import { createProvider } from '../providers/registry.ts';
import { RemoteProvider } from '../providers/remote.ts';
import type { Runtime } from '../runtime.ts';
import { shortPath } from '../util/text.ts';
import { renderHelp } from './banner.ts';
import { c } from './colors.ts';
import { formatCountdown, formatDailyUsage, sessionSecondsLeft } from './freePlan.ts';
import { collapseLines, outputCountLine, renderModelPanel, renderStatusPanel, type StatusPanelInfo } from './ui/results.ts';
import { theme } from './ui/theme.ts';
import { isVerbose } from './verbose.ts';

export async function cmdHelp(): Promise<void> {
  console.log(renderHelp());
}

export async function cmdModel(runtime: Runtime, arg: string): Promise<void> {
  const provider = runtime.provider;
  if (!provider) {
    console.log(renderModelPanel({
      providerAvailable: false,
      providerLabel: '',
      model: '',
      contextWindow: 0,
      providerError: runtime.providerError ?? 'No provider configured.',
    }));
    return;
  }
  const argTrim = arg.trim();

  if (argTrim === '') {
    // When logged in, the backend reports which provider actually served the
    // last request (e.g. NVIDIA NIM after router fallback) — never a key.
    const served = provider instanceof RemoteProvider ? (provider.serverProvider ?? RemoteProvider.sharedServerProvider()) : null;
    console.log(renderModelPanel({
      providerAvailable: true,
      providerLabel: served?.label ?? provider.label,
      servedVia: served ? provider.label : undefined,
      model: provider.getModel().id,
      contextWindow: provider.getModel().contextWindow,
    }));
    console.log(c.dim('Switch with /model <id>. See available ids with /model list.'));
    return;
  }

  if (argTrim === 'list') {
    console.log(c.dim('Fetching models…'));
    const models = await provider.listModels();
    if (models.length === 0) {
      console.log(c.yellow('Could not list models for this provider — set one directly with /model <id>.'));
      return;
    }
    console.log(models.map((m) => '  ' + theme().model(m)).join('\n'));
    console.log(c.dim(`\nDefault candidates: ${DEFAULT_MODELS.join(', ')}`));
    return;
  }

  // Switching model
  try {
    provider.setModel(argTrim);
  } catch (err) {
    console.log(c.red(`Could not switch model: ${(err as Error).message}`));
    return;
  }
  saveAppConfig({ ...loadAppConfig(), provider: provider.id, model: argTrim });
  console.log(c.green(`Model set to ${argTrim} (saved).`));
}

export async function cmdStatus(runtime: Runtime): Promise<void> {
  const p = runtime.project;
  const git = gitSummary(runtime.root);
  const provider = runtime.provider;
  const session = runtime.session;

  const served = provider instanceof RemoteProvider ? (provider.serverProvider ?? RemoteProvider.sharedServerProvider()) : null;
  const info: StatusPanelInfo = {
    project: {
      directory: shortPath(runtime.root, homedir()),
      type: projectLabel(p),
      packageManager: p.packageManager,
      languages: p.languages,
      configFiles: p.configFiles,
      testCommand: p.testCommand ?? undefined,
      buildCommand: p.buildCommand ?? undefined,
    },
    git: {
      isRepo: git.isRepo,
      branch: git.branch,
      hasChanges: git.hasChanges,
      statusLines: git.statusLines,
    },
    provider: provider
      ? {
          available: true,
          error: null,
          label: served?.label ?? provider.label,
          servedVia: served ? provider.label : null,
          model: provider.getModel().id,
          contextWindow: provider.getModel().contextWindow,
        }
      : {
          available: false,
          error: runtime.providerError ?? 'not configured',
          label: '',
          servedVia: null,
          model: '',
          contextWindow: 0,
        },
    session: {
      messages: session.messageCount,
      toolCalls: session.stats.toolCalls,
      runs: session.stats.runs,
      inputTokens: session.stats.inputTokens,
      outputTokens: session.stats.outputTokens,
      undoSnapshots: runtime.undo.count,
    },
    freePlan: await freePlanStatusLines(),
    runtime: {
      node: process.version,
      platform: process.platform,
      stateDir: shortPath(runtime.root + '/.zeesh', homedir()),
    },
  };

  console.log(renderStatusPanel(info));
}

/**
 * GRACE FREE daily session section of /status. Server-authoritative and
 * best-effort: offline / pre-session backends just print a dim note.
 */
async function freePlanStatusLines(): Promise<string[]> {
  const session = loadSession();
  if (!session) {
    return ['  Not logged in — local/offline mode (no session limits).'];
  }
  try {
    const api = new ApiClient(session.apiUrl, 3000);
    // Server-authoritative status label (active/expired/ended/none) — the
    // CLI only renders what the server says; it never enforces.
    const status = await api.getSessionStatus(session.token);
    const label = sessionStatusDisplay(status.session.status);
    const state = status.session;
    const total = state.sessionsUsed + state.sessionsRemaining;
    const lines = [
      `  Status:       ${label}`,
      `  Sessions:     ${state.sessionsUsed} / ${total} used today`,
      `  Daily usage:  ${formatDailyUsage(state.dailyUsedSeconds)} / ${formatDailyUsage(state.dailyLimitSeconds)}`,
    ];
    const left = sessionSecondsLeft(state.expires_at ?? state.sessionExpiresAt);
    lines.push(
      left !== null
        ? `  Time left:    ${formatCountdown(left)} (session ${state.currentSession ?? '—'})`
        : `  Time left:    no active session (${state.sessionsRemaining} remaining)`,
    );
    if (state.sessionsRemaining === 0 && left === null) {
      lines.push(`  ${c.yellow(`Daily quota reached — new sessions unlock at 00:00 UTC.`)}`);
    }
    return lines;
  } catch {
    return [`  ${c.dim(`Could not reach the backend (offline) — server enforces limits.`)}`];
  }
}

/**
 * Render the server's session status label with a state-appropriate color.
 * Unknown states are rendered dim rather than crashing — the CLI must keep
 * working even when the server adds new states. Exported for tests.
 */
export function sessionStatusDisplay(status: string): string {
  switch (status) {
    case 'active':
      return c.green('active');
    case 'expired':
      return c.yellow('expired — the next request starts a fresh session');
    case 'ended':
      return c.yellow('ended — the next request starts a fresh session');
    case 'none':
      return c.dim('no session yet — the first request starts one');
    case 'rate_limited':
      return c.red('rate limited by the server');
    case 'model_unavailable':
      return c.red('model unavailable — the server will fall back');
    case 'banned':
      return c.red('account disabled');
    case 'unauthorized':
      return c.red('session invalid — run grace login');
    default:
      return c.dim(status);
  }
}

export async function cmdDiff(runtime: Runtime): Promise<void> {
  const git = gitSummary(runtime.root);
  if (!git.isRepo) {
    const pending = runtime.undo.pendingChanges();
    if (pending.length === 0) {
      console.log(c.yellow('Not a git repository and no agent changes recorded yet.'));
    } else {
      console.log(c.bold('Files changed by the agent (no git repo detected):'));
      console.log(pending.map((l) => '  ' + l).join('\n'));
    }
    return;
  }

  const status = statusShort(runtime.root);
  if (!status || status.trim() === '') {
    console.log(c.green('Working tree clean — no changes to show.'));
    return;
  }

  const statusLines = status.split('\n');
  console.log(c.bold('git status --short'));
  if (statusLines.length > 40 && !isVerbose()) console.log(outputCountLine('Command output', statusLines.length));
  console.log(collapseLines(status, { max: 40, verbose: isVerbose() }));

  const stat = diffStat(runtime.root);
  if (stat.trim()) {
    console.log(c.bold('\ngit diff --stat'));
    console.log('  ' + stat.split('\n').join('\n  '));
  }

  const diff = diffUnified(runtime.root, 500);
  if (diff.trim()) {
    const diffLines = diff.split('\n');
    console.log(c.bold('\ngit diff'));
    if (diffLines.length > 120 && !isVerbose()) console.log(outputCountLine('Command output', diffLines.length));
    console.log(collapseLines(diff, { max: 120, verbose: isVerbose() }));
  }
}

/**
 * /clear — clear the terminal screen (a real terminal clear, not a fake one).
 * The conversation is untouched: use /reset to clear the task context.
 */
export async function cmdClear(): Promise<void> {
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[2J\x1b[H');
  }
}

/** /reset — wipe the conversation/task context but keep the workspace. */
export async function cmdReset(runtime: Runtime): Promise<void> {
  runtime.session.clear();
  console.log(c.green('Conversation and task context cleared (workspace kept).'));
}

/**
 * /provider — show how the provider is selected, or switch to a local Groq
 * provider when a GROQ_API_KEY is configured. Other providers are served
 * server-side through the GRACE backend and can't be switched to locally.
 */
export async function cmdProvider(runtime: Runtime, arg: string): Promise<void> {
  const provider = runtime.provider;
  const argTrim = arg.trim();

  if (argTrim === '') {
    const served = provider instanceof RemoteProvider ? (provider.serverProvider ?? RemoteProvider.sharedServerProvider()) : null;
    console.log(renderModelPanel({
      providerAvailable: provider !== null,
      providerLabel: served?.label ?? provider?.label ?? '',
      servedVia: served ? provider?.label : undefined,
      model: provider?.getModel().id ?? '',
      contextWindow: provider?.getModel().contextWindow ?? 0,
      providerError: runtime.providerError ?? 'No provider configured.',
    }));
    console.log('');
    console.log(c.dim('How the provider is chosen:'));
    console.log(c.dim('  • A local GROQ_API_KEY uses Groq directly (offline/self-hosted).'));
    console.log(c.dim('  • Otherwise model calls proxy through the GRACE backend.'));
    console.log(c.dim('  • /provider groq switches to a local Groq provider (key required).'));
    return;
  }

  const target = argTrim.toLowerCase();
  if (target === 'groq') {
    const key = groqApiKey();
    if (!key) {
      console.log(c.red('No GROQ_API_KEY configured — add it to ~/.zeesh/env or the project .env first.'));
      return;
    }
    const model = pickModelForProvider('groq', 'coding', runtime.model);
    runtime.provider = createProvider('groq', { apiKey: key, model });
    runtime.model = model;
    saveAppConfig({ ...loadAppConfig(), provider: 'groq', model });
    console.log(c.green(`Provider set to Groq (${model}).`));
    return;
  }
  if (target === 'nvidia' || target === 'deepseek') {
    console.log(
      c.yellow(`"${target}" is served server-side only (GRACE backend). A local key for it is not supported on the CLI — /provider groq uses Groq directly; otherwise /login routes through the backend.`),
    );
    return;
  }
  console.log(c.yellow(`Unknown provider "${argTrim}". Supported locally: groq — others route through the GRACE backend.`));
}

export async function cmdUndo(runtime: Runtime): Promise<void> {
  const result = runtime.undo.undo();
  if (!result) {
    console.log(c.yellow('Nothing to undo.'));
    return;
  }
  console.log(
    c.green(
      `Reverted ${result.hadPrevious ? 'modifications to' : 'creation of'} ${result.file}`,
    ),
  );
  console.log(c.dim('Use /diff to review the working tree.'));
}
