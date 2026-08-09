import { homedir } from 'node:os';
import { loadAppConfig, saveAppConfig, DEFAULT_MODELS } from '../config/config.ts';
import { diffStat, diffUnified, gitSummary, statusShort } from '../git/git.ts';
import { projectLabel } from '../project/detect.ts';
import type { Runtime } from '../runtime.ts';
import { shortPath } from '../util/text.ts';
import { c } from './colors.ts';
import { renderHelp } from './banner.ts';

export async function cmdHelp(): Promise<void> {
  console.log(renderHelp());
}

export async function cmdModel(runtime: Runtime, arg: string): Promise<void> {
  const provider = runtime.provider;
  if (!provider) {
    console.log(c.red(runtime.providerError ?? 'No provider configured.'));
    return;
  }
  const argTrim = arg.trim();

  if (argTrim === '' ) {
    console.log(`Provider: ${provider.label} (${provider.id})`);
    console.log(`Model:    ${provider.getModel().id}`);
    console.log(`Context:  ~${Math.round(provider.getModel().contextWindow / 1000)}k tokens`);
    console.log(c.dim('Switch with /model <id>. See available ids with /model list.'));
    return;
  }

  if (argTrim === 'list') {
    console.log(c.dim('Fetching models…'));
    const models = await provider.listModels();
    if (models.length === 0) {
      console.log(c.yellow('Could not list models (check your API key and network).'));
      return;
    }
    console.log(models.map((m) => '  ' + m).join('\n'));
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

  console.log(c.bold('Project'));
  console.log(`  Root:         ${shortPath(runtime.root, homedir())}`);
  console.log(`  Type:         ${projectLabel(p)}`);
  console.log(`  Package mgr:  ${p.packageManager}`);
  console.log(`  Languages:    ${p.languages.join(', ') || '—'}`);
  if (p.configFiles.length) console.log(`  Config:       ${p.configFiles.slice(0, 10).join(', ')}`);
  if (p.testCommand || p.buildCommand) {
    console.log(`  Test/build:   ${[p.testCommand, p.buildCommand].filter(Boolean).join(' · ')}`);
  }

  console.log(c.bold('Git'));
  if (!git.isRepo) {
    console.log('  Not a git repository');
  } else {
    console.log(`  Branch:       ${git.branch ?? '(detached)'}`);
    console.log(`  Working tree: ${git.hasChanges ? c.yellow(`${git.statusLines} change(s)`) : c.green('clean')}`);
  }

  console.log(c.bold('Model'));
  if (provider) {
    console.log(`  Provider:     ${provider.label}`);
    console.log(`  Model:        ${provider.getModel().id}`);
  } else {
    console.log(`  ${c.red(runtime.providerError ?? 'not configured')}`);
  }

  console.log(c.bold('Session'));
  console.log(`  Messages:     ${runtime.session.messageCount}`);
  console.log(`  Tool calls:   ${runtime.session.stats.toolCalls}`);
  console.log(`  Runs:         ${runtime.session.stats.runs}`);
  console.log(`  Tokens (in/out): ${runtime.session.stats.inputTokens} / ${runtime.session.stats.outputTokens}`);
  console.log(`  Undo stack:   ${runtime.undo.count} snapshot(s)`);

  console.log(c.bold('Runtime'));
  console.log(`  node ${process.version} · ${process.platform}`);
  console.log(`  State dir:    ${shortPath(runtime.root + '/.myagent', homedir())}`);
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
  console.log(c.bold('git status --short'));
  console.log(status.split('\n').slice(0, 60).map((l) => '  ' + l).join('\n'));

  const stat = diffStat(runtime.root);
  if (stat.trim()) {
    console.log(c.bold('\ngit diff --stat'));
    console.log('  ' + stat.split('\n').join('\n  '));
  }

  const diff = diffUnified(runtime.root, 200);
  if (diff.trim()) {
    console.log(c.bold('\ngit diff'));
    console.log(diff);
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


