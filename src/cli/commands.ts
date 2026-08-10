import { homedir } from 'node:os';
import { ApiClient } from '../auth/client.ts';
import { loadSession } from '../auth/session.ts';
import { loadAppConfig, saveAppConfig, DEFAULT_MODELS } from '../config/config.ts';
import { diffStat, diffUnified, gitSummary, statusShort } from '../git/git.ts';
import { projectLabel } from '../project/detect.ts';
import { RemoteProvider } from '../providers/remote.ts';
import type { Runtime } from '../runtime.ts';
import { shortPath } from '../util/text.ts';
import { renderHelp } from './banner.ts';
import { c } from './colors.ts';
import { formatCountdown, formatDailyUsage, sessionSecondsLeft } from './freePlan.ts';
import { collapseLines, outputCountLine, renderModelPanel, renderStatusPanel, type StatusPanelInfo } from './ui/results.ts';
import { symbols, theme } from './ui/theme.ts';
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
    const served = provider instanceof RemoteProvider ? provider.serverProvider : null;
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

  const served = provider instanceof RemoteProvider ? provider.serverProvider : null;
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
  const sym = symbols();
  const session = loadSession();
  if (!session) {
    return ['  Not logged in — local/offline mode (no session limits).'];
  }
  try {
    const state = await new ApiClient(session.apiUrl, 3000).getUsage(session.token);
    const total = state.sessionsUsed + state.sessionsRemaining;
    const lines = [
      `  Sessions:     ${state.sessionsUsed} / ${total} used today`,
      `  Daily usage:  ${formatDailyUsage(state.dailyUsedSeconds)} / ${formatDailyUsage(state.dailyLimitSeconds)}`,
    ];
    const left = sessionSecondsLeft(state.sessionExpiresAt);
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

export async function cmdClear(runtime: Runtime): Promise<void> {
  runtime.session.clear();
  console.log(c.green('Conversation history cleared.'));
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
