import { Coordinator } from '../agents/coordinator.ts';
import type { CoordinatorEvent } from '../agents/types.ts';
import { reportRunUsage } from '../auth/reporting.ts';
import { ProjectIndexService } from '../project/index.ts';
import { RemoteProvider } from '../providers/remote.ts';
import type { Runtime } from '../runtime.ts';
import { formatDuration } from '../util/text.ts';
import { c } from './colors.ts';
import { sessionRolloverNote, sessionStatusLine } from './freePlan.ts';

export interface TaskRunOptions {
  /** Await the usage report (one-shot) vs fire-and-forget (REPL). */
  awaitUsageReport?: boolean;
}

/** One shared, maintained project index per runtime (survives across tasks). */
const indexByRuntime = new WeakMap<object, ProjectIndexService>();

/**
 * Run one user task through the ZEESH coordinator.
 *
 * Shows concise progress (`· Planning… → Project Scout → … → Done`) without
 * exposing any agent chain-of-thought, then prints the composed final answer,
 * changed files, run stats, the ZEESH FREE quota line and usage reporting —
 * the same surface as the pre-coordinator CLI, just orchestrated.
 */
export async function runTask(runtime: Runtime, input: string, opts: TaskRunOptions = {}): Promise<number> {
  if (!runtime.provider) {
    console.log(c.red(runtime.providerError ?? 'No AI provider configured.'));
    return 1;
  }

  let index = indexByRuntime.get(runtime);
  if (!index) {
    index = new ProjectIndexService(runtime.root);
    indexByRuntime.set(runtime, index);
  }

  console.log('');
  const startedAt = Date.now();
  const coordinator = new Coordinator({ runtime, projectIndex: index, onEvent: renderProgress });
  const result = await coordinator.run(input);
  const executionTimeMs = Date.now() - startedAt;
  console.log('');

  // The editor may have changed files — make sure the next task sees a fresh index.
  if (result.changedFiles.length > 0) index.invalidate();

  console.log(result.finalAnswer);
  console.log('');

  if (result.changedFiles.length > 0) {
    console.log(c.bold('Changed files:') + ' ' + result.changedFiles.join(', '));
  }
  const lines: string[] = [];
  lines.push(c.dim(`${result.iterations} iteration(s) · ${result.toolCalls} tool call(s) · ${formatDuration(executionTimeMs)}`));
  if (result.usage) lines.push(c.dim(`tokens: ${result.usage.inputTokens} in · ${result.usage.outputTokens} out`));
  console.log(lines.join('\n'));

  // ZEESH FREE: daily session quota from the server's last response. With the
  // default provider factory every agent shares runtime.provider, so the most
  // recent response (possibly the reviewer in a parallel final step) is always
  // the freshest server-authoritative state.
  if (runtime.provider instanceof RemoteProvider) {
    const last = runtime.provider.lastSession;
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
        console.log(c.dim('· usage report failed (backend offline) — run continued locally.'));
      }
    });

  if (opts.awaitUsageReport) {
    await report();
  } else {
    void report();
  }

  return 0;
}

/** Concise, non-chain-of-thought progress rendering. */
function renderProgress(event: CoordinatorEvent): void {
  switch (event.type) {
    case 'planning':
      console.log(c.gray('· Planning…'));
      break;
    case 'step-start':
      break; // agents within a step are rendered individually
    case 'agent-start':
      console.log(`  ${c.cyan('→')} ${event.label}`);
      break;
    case 'agent-done': {
      const mark =
        event.status === 'completed' ? c.green('✓') : event.status === 'failed' ? c.red('✗') : c.yellow('·');
      const detail =
        event.status === 'completed' ? oneLiner(event.summary) : event.status === 'failed' ? oneLiner(event.error ?? event.summary) : oneLiner(event.summary);
      console.log(`  ${mark} ${event.label} — ${c.dim(detail)}`);
      break;
    }
    case 'done':
      console.log(c.gray('· Done'));
      break;
  }
}

function oneLiner(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 89)}…` : flat;
}
