/**
 * Safety policy (Milestone 7 foundations, wired in from Milestone 5 onward).
 *
 *  - Dangerous commands require explicit user confirmation before execution.
 *  - Protected files (.env, keys, credentials, SSH material) are never
 *    read/written by file tools, and references to them in shell commands
 *    are flagged.
 *  - Secret-like values are redacted from command output before it is
 *    sent back to the model.
 */
import { realpathSync } from 'node:fs';
import { basename, join, normalize, sep } from 'node:path';

export interface DangerPattern {
  re: RegExp;
  reason: string;
}

/** Patterns that make a command require user confirmation. */
export const DANGEROUS_PATTERNS: DangerPattern[] = [
  { re: /(^|\s)rm\s+(-{1,2}[a-zA-Z]*[rf][a-zA-Z]*\s+)+/i, reason: 'recursive/forced file deletion' },
  { re: /(^|\s)rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*(\/|~|\*|\.\s|\.\*)/, reason: 'deleting root/home/wildcard paths' },
  // `rm file -rf` / `rmdir --recursive --force` — flags anywhere in the invocation
  { re: /(^|\s)(rm|rmdir)\s+[^\n;|&]*\s+-{1,2}[a-zA-Z]*[rfR][a-zA-Z]*\b/i, reason: 'recursive/forced file deletion' },
  { re: /(^|\s)(rm|rmdir)\s+[^\n;|&]*(--recursive|--force|--dir)\b/i, reason: 'recursive/forced file deletion' },
  { re: /(^|\s)(rmdir|unlink)\s+/i, reason: 'directory/file removal' },
  { re: /(^|\s)(sudo|pkexec|doas)\s+/i, reason: 'privilege escalation' },
  { re: /(^|\s)su\s+-/i, reason: 'switch user (root)' },
  { re: /\bgit\s+(push|pull|fetch)\b/i, reason: 'network git operation' },
  { re: /\bgit\s+reset\s+(--hard|-{1,2}h)\b/i, reason: 'hard git reset (destroys commits)' },
  { re: /\bgit\s+clean\s+-[a-z]*f/i, reason: 'git clean -f (deletes untracked files)' },
  { re: /\bgit\s+checkout\s+(--|\.)/i, reason: 'discards working-tree changes' },
  { re: /\bgit\s+(merge|rebase|cherry-pick|revert)\b/i, reason: 'history-modifying git operation' },
  { re: /\bgit\s+push\s+(-f|--force)/i, reason: 'force push (rewrites remote history)' },
  { re: /\bdrop\s+(database|table|schema|view)\b/i, reason: 'database destruction' },
  { re: /\btruncate\s+(table|database)\b/i, reason: 'database data deletion' },
  { re: /\bDELETE\s+FROM\b/i, reason: 'bulk database row deletion' },
  { re: /\b(dd|mkfs|fdisk|mkswap)\b/i, reason: 'low-level disk operation' },
  { re: /\b(shutdown|reboot|poweroff|halt|init\s+0)\b/i, reason: 'system shutdown/reboot' },
  { re: /\bkill\s+-9\b/i, reason: 'force-kill process' },
  { re: /\b(chmod|chown)\s+-R\b/i, reason: 'recursive permission change' },
  { re: /\bcurl\b[^|]*\|\s*(ba)?sh\b/i, reason: 'pipe remote script into shell' },
  { re: /\bwget\b[^|]*\|\s*(ba)?sh\b/i, reason: 'pipe remote script into shell' },
  { re: /\bnpm\s+(publish|uninstall\s+-g|install\s+-g|rm\s+-g)\b/i, reason: 'global/remote package operation' },
  { re: /\b(terraform|tofu)\s+.*\b(apply|destroy)\b/i, reason: 'terraform apply/destroy (infra)' },
  { re: /\bkubectl\s+.*\b(delete|apply|replace)\b/i, reason: 'kubectl mutate (infra)' },
  { re: /\bhelm\s+.*\b(delete|upgrade|install)\b/i, reason: 'helm mutate (infra)' },
  { re: /\b(systemctl|service)\s+\S+\s+(stop|kill|reset-failed)\b/i, reason: 'stops a system service' },
  { re: /\b(dropdb|createdb)\b/i, reason: 'database create/drop' },
];

/** Filenames / path fragments that file tools must never touch. */
export function isProtectedPath(absPath: string): boolean {
  const name = basename(absPath);
  const norm = normalize(absPath).split(sep).join('/');

  if (name.startsWith('.env')) return true; // .env, .env.local, .env.production…
  if (/\.(pem|p12|pfx|key|p8|keystore|jks)$/i.test(name)) return true;
  if (/^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/.test(name)) return true;
  if (/^credentials?$/i.test(name)) return true;
  if (/^(\.netrc|\.npmrc|\.pypirc|\.htpasswd)$/.test(name)) return true;
  if (/^secret/.test(name) && /\.(ya?ml|json|env|txt)$/i.test(name)) return true;
  if (/\.docker[\\/]config\.json$/.test(norm)) return true;
  if (norm.includes('.ssh/')) return true;
  return false;
}

/** Characters that terminate a filename token in a shell command. */
const TOKEN_END = `[;\\s$&|<>'\"(){}]`;

/** True when a command string references a protected file (may leak secrets). */
export function commandTouchesProtected(command: string): boolean {
  const envLike = new RegExp(`(^|\\s|['"])[^\\s'"]*\\.env(\\.[\\w-]+)?($|${TOKEN_END})`, 'i');
  const keyLike = new RegExp(`\\.(pem|p12|pfx|key|p8)($|${TOKEN_END})`, 'i');
  return envLike.test(command) || keyLike.test(command) || /\b(id_rsa|id_ed25519|\.ssh)\b/i.test(command);
}

export type RiskLevel = 'safe' | 'flagged';

export interface CommandAssessment {
  level: RiskLevel;
  reasons: string[];
}

export function assessCommand(command: string): CommandAssessment {
  const reasons: string[] = [];
  for (const p of DANGEROUS_PATTERNS) {
    if (p.re.test(command)) reasons.push(p.reason);
  }
  if (commandTouchesProtected(command)) {
    reasons.push('references a protected file (.env / key / credential) — may expose secrets');
  }
  return { level: reasons.length > 0 ? 'flagged' : 'safe', reasons: [...new Set(reasons)] };
}

/** Redact secret-like values from text (applied to command output and search hits). */
export function redactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    .replace(/\bgsk_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bnvapi-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/(xox[baprs]-)[A-Za-z0-9-]{10,}/g, '$1[REDACTED]')
    .replace(/(github_pat_|ghp_|gho_)[A-Za-z0-9_]{20,}/g, '$1[REDACTED]');
}

export type ResolveResult = { abs: string; real: string; ok: true } | { abs: string; ok: false; reason: string };

/**
 * Resolve a tool-provided path and ensure it stays inside the project root.
 * Containment is checked against BOTH the lexical path and the resolved
 * realpath, so symlinks that point outside the root (or at protected files)
 * are caught. Windows paths are compared case-insensitively.
 */
export function resolveInProject(root: string, p: string): ResolveResult {
  const isAbsolute = p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(p);
  const abs = normalize(isAbsolute ? p : join(root, p));
  const real = resolveReal(abs);
  if (!isWithin(root, abs) || !isWithin(root, real)) {
    return { abs, ok: false, reason: `path "${p}" escapes the project root (${root})` };
  }
  return { abs, real, ok: true };
}

function isWithin(root: string, target: string): boolean {
  const rootNorm = normCase(normalize(root));
  const tNorm = normCase(normalize(target));
  return tNorm === rootNorm || tNorm.startsWith(rootNorm.endsWith(sep) ? rootNorm : rootNorm + sep);
}

function normCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function resolveReal(abs: string): string {
  try {
    return realpathSync(abs);
  } catch {
    return abs; // file may not exist yet (write_file) — lexical check still applies
  }
}
