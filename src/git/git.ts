import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runGit(root: string, args: string[]): GitRunResult {
  const res = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? '').toString(),
    stderr: (res.stderr ?? '').toString(),
    code: res.status,
  };
}

export function isGitRepo(root: string): boolean {
  if (existsSync(join(root, '.git'))) return true;
  const res = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  return res.ok && res.stdout.trim() === 'true';
}

export function currentBranch(root: string): string | null {
  const res = runGit(root, ['branch', '--show-current']);
  if (res.ok && res.stdout.trim()) return res.stdout.trim();
  return null;
}

export function statusShort(root: string): string {
  const res = runGit(root, ['status', '--short']);
  return res.ok ? res.stdout.trimEnd() : `(git unavailable: ${res.stderr.trim()})`;
}

export function diffStat(root: string): string {
  const res = runGit(root, ['diff', '--stat']);
  return res.ok ? res.stdout.trimEnd() : '';
}

export function diffUnified(root: string, maxLines = 300): string {
  const res = runGit(root, ['diff']);
  if (!res.ok) return '';
  const lines = res.stdout.split('\n');
  if (lines.length <= maxLines) return res.stdout;
  return lines.slice(0, maxLines).join('\n') + `\n… [diff truncated, ${lines.length - maxLines} more lines]`;
}

export function recentLog(root: string, n = 5): string {
  const res = runGit(root, ['log', `-${n}`, '--oneline', '--no-decorate']);
  return res.ok ? res.stdout.trimEnd() : '';
}

/** Compact git context injected into the agent's system prompt. */
export function gitAwareness(root: string): string {
  const g = gitSummary(root);
  if (!g.isRepo) return '(not a git repository)';
  const parts = [`branch: ${g.branch ?? 'detached'}`, `working tree: ${g.hasChanges ? `${g.statusLines} change(s)` : 'clean'}`];
  const status = statusShort(root);
  if (status.trim()) parts.push(`status:\n${status.split('\n').slice(0, 15).join('\n')}`);
  const recent = recentLog(root, 3);
  if (recent.trim()) parts.push(`recent commits:\n${recent}`);
  return parts.join('\n');
}

export interface GitSummary {
  branch: string | null;
  statusLines: number;
  hasChanges: boolean;
  isRepo: boolean;
}

export function gitSummary(root: string): GitSummary {
  const isRepo = isGitRepo(root);
  if (!isRepo) return { branch: null, statusLines: 0, hasChanges: false, isRepo: false };
  const short = statusShort(root);
  const statusLines = short.split('\n').filter((l) => l.trim().length > 0).length;
  return { branch: currentBranch(root), statusLines, hasChanges: statusLines > 0, isRepo: true };
}
