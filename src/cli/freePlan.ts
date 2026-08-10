/**
 * ZEESH FREE session display helpers (Milestone 13).
 *
 * Pure rendering only — every number comes from the backend's daily session
 * state (GET /api/usage / POST /api/provider response), so the CLI never
 * trusts or stores quota locally. All functions degrade gracefully: pass null
 * / invalid data and they return nothing to print.
 */
import type { DailySessionState } from '../auth/client.ts';
import { c } from './colors.ts';

/** Render seconds as a compact countdown, e.g. 47m 12s ('' when invalid). */
export function formatCountdown(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '';
  const total = Math.max(0, Math.floor(seconds));
  if (total <= 0) return 'expired';
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Render daily usage totals with hours, e.g. 6h, 1h 35m, 10m, 45s
 * ('' when invalid). formatDuration only goes up to minutes — daily
 * totals need the hour unit.
 */
export function formatDailyUsage(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/**
 * Seconds left in the current session from an ISO expiresAt timestamp
 * (computed locally for display only — enforcement stays server-side).
 */
export function sessionSecondsLeft(expiresAt: string | null | undefined): number | null {
  if (!expiresAt) return null;
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((t - Date.now()) / 1000));
}

/**
 * The "Session X / 6 · time remaining · today's usage" line shown after each
 * run. Returns '' when there is no session state to display.
 */
export function sessionStatusLine(
  state: DailySessionState | null | undefined,
): string {
  if (!state || typeof state.sessionsUsed !== 'number') return '';
  const total = state.sessionsUsed + state.sessionsRemaining;
  const left = sessionSecondsLeft(state.sessionExpiresAt);
  const remaining = left !== null ? formatCountdown(left) : 'no active session';
  const usedToday = formatDailyUsage(state.dailyUsedSeconds);
  const limitToday = formatDailyUsage(state.dailyLimitSeconds);
  return c.dim(`Session ${state.currentSession ?? state.sessionsUsed} / ${total} · ${remaining} left · ${usedToday} / ${limitToday} used today`);
}

/** Note shown when the server rolled the user into a fresh session. */
export function sessionRolloverNote(state: DailySessionState | null | undefined): string {
  if (!state) return '';
  return c.dim(`Session ${state.currentSession} of ${state.sessionsUsed + state.sessionsRemaining} started — the previous session expired.`);
}

/**
 * Short banner row: "Free plan: 2/6 sessions · 41m left" or a simpler
 * availability line when no session is active yet. '' when unavailable.
 */
export function bannerFreePlanLine(state: DailySessionState | null | undefined): string {
  if (!state || typeof state.sessionsUsed !== 'number') return '';
  const total = state.sessionsUsed + state.sessionsRemaining;
  if (state.currentSession != null && state.sessionExpiresAt) {
    const left = formatCountdown(sessionSecondsLeft(state.sessionExpiresAt));
    return c.green(`Free plan · Session ${state.currentSession}/${total} · ${left} left · ${formatDailyUsage(state.dailyUsedSeconds)} used today`);
  }
  if (state.sessionsRemaining === 0) {
    return c.yellow(`Free plan · all ${total} sessions used today — more at 00:00 UTC`);
  }
  return c.green(`Free plan · ${state.sessionsRemaining} of ${total} sessions available today (${formatDailyUsage(state.dailyLimitSeconds)} max)`);
}
