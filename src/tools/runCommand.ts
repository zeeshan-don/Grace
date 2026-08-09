import { exec, spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { assessCommand, redactSecrets } from '../safety/policy.ts';
import { truncateMiddle } from '../util/text.ts';
import type { Tool, ToolContext } from './registry.ts';

const DEFAULT_TIMEOUT_SEC = 120;
const MAX_OUTPUT_CHARS = 100_000;

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export function runShellCommand(command: string, opts: { cwd: string; timeoutSec?: number; shell?: string }): Promise<RunResult> {
  return new Promise((resolve) => {
    const timeoutMs = (opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
    const child = exec(
      command,
      {
        cwd: opts.cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        shell: opts.shell,
        windowsHide: true,
        killSignal: 'SIGKILL',
      },
      (error, stdout, stderr) => {
        let timedOut = false;
        let exitCode: number | null = 0;
        if (error) {
          const err = error as NodeJS.ErrnoException & { killed?: boolean };
          timedOut = Boolean(err.killed);
          if (timedOut) {
            exitCode = null;
            killProcessTree(child.pid);
          } else if (typeof err.code === 'number') {
            exitCode = err.code; // non-zero exit from the command
          } else {
            exitCode = null; // failed to spawn (ENOENT etc.)
          }
        }
        resolve({
          stdout: (stdout ?? '').toString(),
          stderr: (stderr ?? '').toString(),
          exitCode,
          timedOut,
        });
      },
    );
  });
}

/** On Windows, kill the process tree so grandchildren (e.g. npm → node) don't linger. */
function killProcessTree(pid: number | undefined): void {
  if (!pid || process.platform !== 'win32') return;
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } catch {
    /* best-effort */
  }
}

export function shellForPlatform(): string | undefined {
  const custom = process.env.MYAGENT_SHELL;
  if (custom) return custom;
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  return process.env.SHELL || '/bin/sh';
}

function resolveCwd(projectRoot: string, raw: string): string {
  if (raw === '.') return projectRoot;
  if (isAbsolute(raw)) return raw;
  return join(projectRoot, raw);
}

export function createRunCommandTool(ctx: ToolContext): Tool {
  return {
    name: 'run_command',
    description: 'Run a terminal command; returns stdout/stderr/exit code. Destructive commands require user approval.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command.' },
        cwd: { type: 'string', description: 'Workdir relative to root (default root).' },
        timeoutSec: { type: 'number', description: 'Timeout in seconds.' },
      },
      required: ['command'],
    },
    async execute(args) {
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      if (!command) return 'Error: "command" is required.';

      const cwdRaw = typeof args.cwd === 'string' && args.cwd ? args.cwd : '.';
      const cwd = resolveCwd(ctx.projectRoot, cwdRaw);
      const timeoutSec = typeof args.timeoutSec === 'number' && args.timeoutSec > 0 ? args.timeoutSec : DEFAULT_TIMEOUT_SEC;

      const assessment = assessCommand(command);
      if (assessment.level === 'flagged') {
        const allowed = await ctx.askPermission(command, assessment.reasons);
        if (!allowed) {
          return `Command blocked: user denied permission.\nCommand: ${command}\nReason: ${assessment.reasons.join('; ')}`;
        }
      }

      ctx.onTool?.('run_command', { command, cwd });
      const result = await runShellCommand(command, { cwd, timeoutSec, shell: shellForPlatform() });

      const stdout = truncateMiddle(redactSecrets(result.stdout), MAX_OUTPUT_CHARS);
      const stderr = truncateMiddle(redactSecrets(result.stderr), MAX_OUTPUT_CHARS);
      const exitLine = result.timedOut
        ? `(timed out after ${timeoutSec}s — killed)`
        : `(exit code ${result.exitCode === null ? 'unknown' : result.exitCode})`;

      const parts: string[] = [];
      if (stdout.trim()) parts.push(`STDOUT:\n${stdout}`);
      if (stderr.trim()) parts.push(`STDERR:\n${stderr}`);
      if (result.exitCode !== 0) {
        parts.push(`Command failed ${exitLine}. Read the error output and fix the issue, then re-run.`);
      } else {
        parts.push(`Command succeeded ${exitLine}.`);
      }
      return parts.join('\n\n');
    },
  };
}
