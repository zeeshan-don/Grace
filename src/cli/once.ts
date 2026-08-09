import { homedir } from 'node:os';
import { cwd, stdout } from 'node:process';
import { AgentLoop } from '../agent/loop.ts';
import { reportRunUsage } from '../auth/reporting.ts';
import { PRODUCT, VERSION } from '../meta.ts';
import { loadEnv } from '../config/config.ts';
import { createRuntime } from '../runtime.ts';
import { shortPath } from '../util/text.ts';
import { c } from './colors.ts';

export interface OnceOptions {
  yes?: boolean;
  model?: string;
}

export async function runOnce(prompt: string, opts: OnceOptions = {}): Promise<number> {
  const root = cwd();
  loadEnv(root);
  const runtime = createRuntime(root, { yes: opts.yes, model: opts.model });

  console.log(c.dim(`${PRODUCT} v${VERSION} — one-shot run in ${shortPath(root, homedir())}`));

  if (!runtime.provider) {
    console.log(c.red(runtime.providerError ?? 'No AI provider configured.'));
    return 1;
  }

  const loop = new AgentLoop({
    provider: runtime.provider,
    tools: runtime.tools,
    projectRoot: runtime.root,
    project: runtime.project,
    session: runtime.session,
    undo: runtime.undo,
    onStatus: (msg) => console.log(c.gray('· ' + msg)),
    onStream: (text) => stdout.write(text),
    askPermission: runtime.ask,
  });

  const startedAt = Date.now();
  const result = await loop.run(prompt);
  const executionTimeMs = Date.now() - startedAt;
  console.log('');

  const lines: string[] = [];
  if (result.changedFiles.length > 0) lines.push(c.bold('Changed files:') + ' ' + result.changedFiles.join(', '));
  lines.push(c.dim(`${result.iterations} iteration(s) · ${result.toolCalls} tool call(s)`));
  if (result.usage) lines.push(c.dim(`tokens: ${result.usage.inputTokens} in · ${result.usage.outputTokens} out`));
  if (result.reachedLimit) lines.push(c.yellow('Iteration limit reached — rerun to continue.'));
  console.log(lines.join('\n'));

  // Milestone 11-12: report usage when authenticated. Awaited (bounded by the
  // reporter's short timeout) so the process exits cleanly; a backend outage
  // degrades to a quick 'failed' and never breaks the run.
  if (runtime.provider) {
    const outcome = await reportRunUsage({
      prompt,
      model: runtime.provider.getModel().id,
      projectType: runtime.project.type,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      usage: result.usage,
      executionTimeMs,
    });
    if (outcome === 'failed') {
      console.log(c.dim('(usage report failed — backend offline; the run itself completed locally.)'));
    }
  }

  return 0;
}
