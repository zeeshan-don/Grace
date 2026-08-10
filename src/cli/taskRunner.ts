import { Coordinator } from '../agents/coordinator.ts';
import { RoleModelRouter } from '../agents/roleRouter.ts';
import type { CoordinatorRunResult } from '../agents/types.ts';
import { reportRunUsage } from '../auth/reporting.ts';
import { ProjectIndexService } from '../project/index.ts';
import { RemoteProvider } from '../providers/remote.ts';
import type { Runtime } from '../runtime.ts';
import { ProgressRenderer } from './ui/progress.ts';
import { renderError, renderTaskResult } from './ui/results.ts';
import { symbols } from './ui/theme.ts';
import { isVerbose } from './verbose.ts';
import { sessionRolloverNote, sessionStatusLine } from './freePlan.ts';

export interface TaskRunOptions {
  /** Await the usage report (one-shot) vs fire-and-forget (REPL). */
  awaitUsageReport?: boolean;
  /** Show raw diagnostics (plan, agent details, more output). */
  verbose?: boolean;
}

/** One shared, maintained project index per runtime (survives across tasks). */
const indexByRuntime = new WeakMap<object, ProjectIndexService>();

/**
 * Run one user task through the GRACE coordinator.
 *
 * Renders concise structured progress (`· Planning… → Project Scout ✓ …`)
 * without exposing any agent chain-of-thought, then prints composed result
 * sections (Done / Files changed / Validation / Provider / Time / follow-ups),
 * the GRACE FREE quota line and usage reporting.
 */
export async function runTask(runtime: Runtime, input: string, opts: TaskRunOptions = {}): Promise<number> {
  if (!runtime.provider) {
    console.log(renderError(runtime.providerError ?? 'No AI provider configured.'));
    return 1;
  }

  let index = indexByRuntime.get(runtime);
  if (!index) {
    index = new ProjectIndexService(runtime.root);
    indexByRuntime.set(runtime, index);
  }

  console.log('');
  const startedAt = Date.now();
  const progress = new ProgressRenderer({ verbose: opts.verbose ?? isVerbose() });
  // Genuine role-based routing: every subagent resolves its own provider +
  // model through the Model Router (fast/coding/reasoning/review tiers). The
  // coordinator's own planning call uses the REASONING tier.
  const roleRouter = new RoleModelRouter(runtime);
  const coordinator = new Coordinator({
    runtime,
    projectIndex: index,
    onEvent: (e) => progress.event(e),
    providerFactory: (role, spec) => roleRouter.providerFor(role, spec),
    plannerProvider: roleRouter.plannerProvider(),
  });

  let result: CoordinatorRunResult;
  try {
    result = await coordinator.run(input);
  } catch (err) {
    progress.end();
    console.log(renderError('Task failed', (err as Error).message ?? String(err)));
    return 1;
  }
  progress.end();

  const executionTimeMs = Date.now() - startedAt;
  console.log('');

  // The editor may have changed files — make sure the next task sees a fresh index.
  if (result.changedFiles.length > 0) index.invalidate();

  console.log(renderTaskResult({ result, runtime, executionTimeMs, verbose: opts.verbose ?? isVerbose() }));

  // GRACE FREE: daily session quota from the server's last response. Role
  // routing creates one RemoteProvider per agent tier, so the freshest state
  // is the shared view across all instances of this run.
  if (runtime.provider instanceof RemoteProvider) {
    const last = RemoteProvider.sharedSession();
    if (last) {
      const line = sessionStatusLine(last);
      if (line) console.log(line);
      if (last.startedNew) console.log(sessionRolloverNote(last));
    }
  }

  const report = () =>
    reportRunUsage({
      prompt: input,
      model: runtime.provider!.getModel().id,
      projectType: runtime.project.type,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      usage: result.usage,
      executionTimeMs,
    }).then((outcome) => {
      if (outcome === 'failed') {
        console.log(`${symbols().bullet} usage report failed (backend offline) — run continued locally.`);
      }
    });

  if (opts.awaitUsageReport) {
    await report();
  } else {
    void report();
  }

  return 0;
}
