/**
 * Closed-beta gating (Milestone 12).
 *
 *   ZEESH_BETA_MODE=closed  → registration requires the email to be listed in
 *                             ZEESH_BETA_ALLOWLIST (comma-separated).
 *   (unset or 'open')       → unrestricted registration (default).
 *
 * Deliberately minimal: no dashboard, no invite codes — just enough control
 * to let ~10–20 beta testers in and keep everyone else out until Milestone 15
 * has real usage/cost data. Existing accounts are never locked out.
 */
export type BetaMode = 'open' | 'closed';

/** Current beta mode from ZEESH_BETA_MODE (defaults to 'open'). */
export function betaMode(): BetaMode {
  return process.env.ZEESH_BETA_MODE?.trim().toLowerCase() === 'closed' ? 'closed' : 'open';
}

/** Allowlisted emails from ZEESH_BETA_ALLOWLIST (lower-cased). */
export function betaAllowlist(): ReadonlySet<string> {
  const raw = process.env.ZEESH_BETA_ALLOWLIST?.trim();
  if (!raw) return new Set<string>();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export interface BetaAccess {
  /** May this email register at all? */
  allowed: boolean;
  /** Should the account be marked as a beta tester (users.is_beta)? */
  isBeta: boolean;
}

/** Decide beta access for a registration email (email may be un-normalized). */
export function betaAccessFor(email: string): BetaAccess {
  if (betaMode() === 'open') return { allowed: true, isBeta: true };
  const allowed = betaAllowlist().has(email.trim().toLowerCase());
  return { allowed, isBeta: allowed };
}
