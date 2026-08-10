import { homedir } from 'node:os';
import { cwd } from 'node:process';
import { PRODUCT, VERSION } from '../meta.ts';
import { loadEnv } from '../config/config.ts';
import { createRuntime } from '../runtime.ts';
import { shortPath } from '../util/text.ts';
import { c } from './colors.ts';
import { runTask } from './taskRunner.ts';
import { isVerbose, setVerbose } from './verbose.ts';

export interface OnceOptions {
  yes?: boolean;
  model?: string;
  verbose?: boolean;
}

export async function runOnce(prompt: string, opts: OnceOptions = {}): Promise<number> {
  const root = cwd();
  loadEnv(root);
  if (opts.verbose) setVerbose(true);
  const runtime = createRuntime(root, { yes: opts.yes, model: opts.model });

  console.log(c.dim(`${PRODUCT} v${VERSION} — one-shot run in ${shortPath(root, homedir())}`));

  if (!runtime.provider) {
    console.log(c.red(runtime.providerError ?? 'No AI provider configured.'));
    return 1;
  }

  // The whole run (planning, subagents, final answer, stats, free-plan line
  // and usage reporting) is orchestrated by the shared task runner.
  return runTask(runtime, prompt, { awaitUsageReport: true, verbose: isVerbose() });
}