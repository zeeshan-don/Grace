/**
 * TUI runtime facts (GRACE full-screen interface).
 *
 * Every value in the header/home screen comes from real state: the workspace
 * the CLI was launched in, the configured provider/model, the auth session and
 * (best-effort) the server's free-plan quota. Nothing is invented.
 */
import { homedir } from 'node:os';
import { ApiClient } from '../../auth/client.ts';
import { loadSession, sessionExpired } from '../../auth/session.ts';
import { VERSION } from '../../meta.ts';
import { RemoteProvider } from '../../providers/remote.ts';
import type { Runtime } from '../../runtime.ts';
import { shortPath } from '../../util/text.ts';
import { stripAnsi } from '../ui/theme.ts';
import { bannerFreePlanLine, formatCountdown, sessionSecondsLeft } from '../freePlan.ts';
import type { TuiInfo } from './types.ts';

/**
 * Synchronous snapshot of real runtime facts. `freePlanLine` may be passed in
 * from an earlier async fetch (see refreshFreePlan).
 */
export function buildTuiInfo(runtime: Runtime, freePlanLine?: string): TuiInfo {
  const stored = loadSession();
  const loggedIn = stored !== null && !sessionExpired(stored);

  let sessionLabel: string;
  if (loggedIn && stored) {
    sessionLabel = stored.user.email;
  } else {
    sessionLabel = 'Local mode';
  }

  const served = runtime.provider instanceof RemoteProvider ? (runtime.provider.serverProvider ?? RemoteProvider.sharedServerProvider()) : null;
  const providerLabel = runtime.provider ? (served?.label ?? runtime.provider.label) : '';
  const model = runtime.provider ? runtime.provider.getModel().id : '';

  return {
    version: VERSION,
    workspace: shortPath(runtime.root, homedir()),
    provider: providerLabel,
    providerAvailable: runtime.provider !== null,
    providerError: runtime.providerError ?? undefined,
    model,
    session: sessionLabel,
    freePlan: freePlanLine,
  };
}

/**
 * Best-effort free-plan + session-time fetch from the backend (real data).
 * Never delays or breaks the UI: failures just leave the line unset.
 */
export async function refreshFreePlan(runtime: Runtime): Promise<string | undefined> {
  const stored = loadSession();
  if (!stored || sessionExpired(stored)) return undefined;
  if (!(runtime.provider instanceof RemoteProvider)) return undefined;
  try {
    const state = await new ApiClient(stored.apiUrl, 2000).getUsage(stored.token);
    // Seed the shared session view so the live countdown renders even before
    // the first task (display only — the server enforces the session limit).
    RemoteProvider.setSharedSession(state);
    return stripAnsi(bannerFreePlanLine(state));
  } catch {
    return undefined;
  }
}

/** "Local mode" / "user@example.com · 12m left" — real, from the session. */
export function sessionStatusLineFor(runtime: Runtime): string {
  const stored = loadSession();
  if (!stored || sessionExpired(stored)) return 'Local mode';
  return stored.user.email;
}

/** Seconds left in the current free session (display only; server enforces). */
export function sessionCountdown(): string | null {
  const stored = loadSession();
  if (!stored || sessionExpired(stored)) return null;
  const state = RemoteProvider.sharedSession();
  if (!state?.sessionExpiresAt) return null;
  return formatCountdown(sessionSecondsLeft(state.sessionExpiresAt));
}
