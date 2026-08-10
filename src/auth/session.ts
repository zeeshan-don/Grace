/**
 * Local session persistence (Milestone 11).
 *
 * The session token from `grace login` is stored in `~/.zeesh/auth.json`
 * with restrictive file permissions (0o600) so other OS users cannot read it.
 * The token is never logged, never sent to the model, and can be wiped with
 * `grace logout`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface StoredUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface StoredSession {
  /** Backend the token was issued by (e.g. http://localhost:8787). */
  apiUrl: string;
  /** Raw session token — sent as `Authorization: Bearer <token>`. */
  token: string;
  user: StoredUser;
  /** ISO timestamp after which the server rejects the session. */
  expiresAt: string;
  createdAt: string;
}

const DEFAULT_PATH = join(homedir(), '.zeesh', 'auth.json');

export function authSessionPath(): string {
  return DEFAULT_PATH;
}

/** Persist a session (0600). Best-effort — never break the CLI over it. */
export function saveSession(session: StoredSession, path: string = DEFAULT_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(session, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows does not enforce POSIX modes; best-effort.
    }
  } catch {
    // Persistence is best-effort — the user can log in again.
  }
}

/** Load the persisted session, or null when absent/corrupt. */
export function loadSession(path: string = DEFAULT_PATH): StoredSession | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredSession>;
    if (!raw.token || !raw.apiUrl || !raw.user?.id) return null;
    return {
      apiUrl: raw.apiUrl,
      token: raw.token,
      user: {
        id: raw.user.id,
        email: raw.user.email ?? '',
        displayName: raw.user.displayName ?? null,
      },
      expiresAt: raw.expiresAt ?? '',
      createdAt: raw.createdAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** Remove the persisted session (logout). */
export function clearSession(path: string = DEFAULT_PATH): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort
  }
}

/** True when the local copy says the session has already expired. */
export function sessionExpired(session: StoredSession): boolean {
  const t = new Date(session.expiresAt).getTime();
  return Number.isNaN(t) || t <= Date.now();
}
