/**
 * Deterministic Test Runner (NO_LLM tier).
 *
 * The Test Runner must not consume an LLM request merely to run tests. This
 * executor detects the project's test framework, runs the relevant command
 * and returns a structured pass/fail SubagentResult — no model involved.
 *
 * Safety: only commands from the shared test-prefix allowlist are run; any
 * other command is reported as requiring approval, and commands never touch
 * source files. Output is bounded so a huge suite cannot blow up context.
 */
import { matchesPrefix, runShellCommand } from '../tools/runCommand.ts';
import { TEST_PREFIXES } from './capabilities.ts';
import type { ProjectInfo } from '../project/detect.ts';
import type { SubagentResult } from './types.ts';

const RUN_TIMEOUT_SEC = 300;
const MAX_SUMMARY_CHARS = 600;

/** Per-project-type fallback commands when no test command was detected. */
const TEST_COMMANDS_BY_TYPE: Record<string, string> = {
  node: 'npm test',
  python: 'python -m pytest',
  go: 'go test ./...',
  rust: 'cargo test',
  java: 'mvn test',
  ruby: 'bundle exec rspec',
};

function oneLiner(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SUMMARY_CHARS ? `${flat.slice(0, MAX_SUMMARY_CHARS - 1)}…` : flat;
}

export interface DeterministicTestRunnerOptions {
  projectRoot: string;
  project: ProjectInfo;
}

/** Run the project's tests without any model request. */
export async function runDeterministicTestRunner(opts: DeterministicTestRunnerOptions): Promise<SubagentResult> {
  const base: SubagentResult = {
    agent: 'test-runner',
    label: 'Test Runner',
    status: 'skipped',
    summary: '',
    files: [],
    changedFiles: [],
    findings: [],
    recommendations: [],
    iterations: 0,
    toolCalls: 0,
  };

  const command = opts.project.testCommand ?? TEST_COMMANDS_BY_TYPE[opts.project.type];
  if (!command) {
    return { ...base, status: 'skipped', summary: 'No test framework detected — nothing to run.' };
  }
  if (!matchesPrefix(command, TEST_PREFIXES)) {
    return {
      ...base,
      status: 'skipped',
      summary: `Tests need explicit approval ("${command}") — run them manually or approve first.`,
    };
  }

  const result = await runShellCommand(command, { cwd: opts.projectRoot, timeoutSec: RUN_TIMEOUT_SEC });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();

  if (result.timedOut) {
    return { ...base, status: 'failed', summary: `Tests timed out after ${RUN_TIMEOUT_SEC}s.` };
  }
  if (result.exitCode === 0) {
    return {
      ...base,
      status: 'completed',
      summary: output ? `Passed — ${oneLiner(output)}` : 'All tests passed.',
    };
  }
  const detail = oneLiner(output || 'No output captured.');
  const error = `Tests failed (exit ${result.exitCode ?? 'unknown'}): ${detail}`;
  return { ...base, status: 'failed', summary: error, error, findings: [`Tests failed with exit code ${result.exitCode ?? 'unknown'}.`] };
}
