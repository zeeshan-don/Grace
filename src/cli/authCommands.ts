/**
 * Auth CLI commands (Milestone 11): `zeesh login|register|logout|whoami`.
 *
 * Login/register prompt for credentials (passwords are hidden), call the
 * backend, and persist the session token in ~/.zeesh/auth.json (0600).
 * Logout invalidates the session server-side and wipes the local copy.
 * Whoami shows the authenticated identity, validating against the server
 * when reachable and degrading to the cached session when offline.
 */
import { zeeshApiUrl } from '../config/config.ts';
import { ApiClient, ApiError } from '../auth/client.ts';
import { clearSession, loadSession, saveSession, sessionExpired, type StoredSession } from '../auth/session.ts';
import { c } from './colors.ts';
import { promptHidden, promptText } from './input.ts';

/** `zeesh login [email]` */
export async function cmdLogin(arg: string): Promise<number> {
  const existing = loadSession();
  const apiUrl = existing?.apiUrl ?? zeeshApiUrl();
  console.log(c.dim(`ZEESH AI backend: ${apiUrl}`));

  const email = (arg.trim() || (await promptText(c.bold('Email: ')))).trim();
  const password = await promptHidden(c.bold('Password: '));
  if (!email || !password) {
    console.log(c.yellow('Login cancelled.'));
    return 1;
  }

  try {
    const result = await new ApiClient(apiUrl).login(email, password);
    persist(result, apiUrl);
    console.log(c.green(`Logged in as ${result.user.email}.`));
    return 0;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      console.log(c.yellow('Invalid email or password. No account yet? Try "zeesh register".'));
    } else if (err instanceof ApiError && err.status === 429) {
      console.log(c.yellow(`Too many login attempts — try again in ${err.retryAfterSeconds ?? 60}s.`));
    } else if (err instanceof ApiError && err.status === 403) {
      console.log(c.yellow(err.message));
    } else {
      console.log(c.red(err instanceof Error ? err.message : 'Login failed.'));
    }
    return 1;
  }
}

/** `zeesh register [email]` — create an account (password ≥ 8 chars). */
export async function cmdRegister(arg: string): Promise<number> {
  const existing = loadSession();
  const apiUrl = existing?.apiUrl ?? zeeshApiUrl();
  console.log(c.dim(`ZEESH AI backend: ${apiUrl}`));

  const email = (arg.trim() || (await promptText(c.bold('Email: ')))).trim();
  const password = await promptHidden(c.bold('Password: '));
  if (password.length < 8) {
    console.log(c.red('Password must be at least 8 characters.'));
    return 1;
  }
  const confirm = await promptHidden(c.bold('Confirm password: '));
  if (password !== confirm) {
    console.log(c.red('Passwords do not match.'));
    return 1;
  }

  try {
    const result = await new ApiClient(apiUrl).register(email, password);
    persist(result, apiUrl);
    console.log(c.green(`Account created — logged in as ${result.user.email}.`));
    return 0;
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      console.log(c.yellow('An account with this email already exists. Try "zeesh login".'));
    } else if (err instanceof ApiError && err.status === 429) {
      console.log(c.yellow(`Too many attempts — try again in ${err.retryAfterSeconds ?? 60}s.`));
    } else if (err instanceof ApiError && err.status === 403) {
      console.log(c.yellow(err.message));
    } else {
      console.log(c.red(err instanceof Error ? err.message : 'Registration failed.'));
    }
    return 1;
  }
}

/** `zeesh logout` */
export async function cmdLogout(): Promise<number> {
  const session = loadSession();
  if (!session) {
    console.log(c.dim('Not logged in.'));
    return 0;
  }
  let serverOk = true;
  try {
    await new ApiClient(session.apiUrl, 3000).logout(session.token);
  } catch {
    serverOk = false; // Backend unreachable — local logout still succeeds.
  }
  clearSession();
  console.log(c.green(serverOk ? 'Logged out — local session removed.' : 'Logged out locally (backend unreachable — session may still be valid there).'));
  return 0;
}

/** `zeesh whoami` */
export async function cmdWhoami(): Promise<number> {
  const session = loadSession();
  if (!session) {
    console.log(c.dim('Not logged in. Run "zeesh login" to connect to the ZEESH AI backend.'));
    return 1;
  }

  console.log(c.bold('ZEESH AI session'));
  console.log(`  Email:     ${session.user.email}`);
  console.log(`  User ID:   ${session.user.id}`);
  console.log(`  Backend:   ${session.apiUrl}`);
  console.log(`  Expires:   ${session.expiresAt ? new Date(session.expiresAt).toLocaleString() : '—'}`);

  if (sessionExpired(session)) {
    console.log(c.yellow('  Status:    expired — run "zeesh login" again.'));
    return 1;
  }

  try {
    const user = await new ApiClient(session.apiUrl, 5000).me(session.token);
    const display = user.display_name ? ` · ${user.display_name}` : '';
    console.log(c.green(`  Status:    valid${display}`));
    return 0;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      clearSession();
      console.log(c.yellow('  Status:    invalid session — run "zeesh login" again.'));
      return 1;
    }
    console.log(c.dim('  Status:    cannot reach backend (offline) — using cached session'));
    return 0;
  }
}

function persist(result: { token: string; expires_at: string; user: { id: string; email: string; display_name: string | null } }, apiUrl: string): void {
  const session: StoredSession = {
    apiUrl,
    token: result.token,
    user: { id: result.user.id, email: result.user.email, displayName: result.user.display_name },
    expiresAt: result.expires_at,
    createdAt: new Date().toISOString(),
  };
  saveSession(session);
}
