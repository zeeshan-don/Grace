/**
 * Session authentication guard (Milestone 11).
 *
 * Protected endpoints require `Authorization: Bearer <session_token>`, where
 * the token was issued by POST /api/auth/login or POST /api/auth/register.
 * The server stores only the SHA-256 hash of the token (sessions.token_hash)
 * and scrypt hashes of passwords (users.password_hash) — no raw credentials
 * ever live server-side or in logs.
 */
import { AuthService, type AuthUser } from './authService.ts';
import type { Db } from './db.ts';
import type { ApiRequest } from './types.ts';

const BEARER = /^Bearer\s+(.+)$/i;

export type AuthResult = { ok: true; user: AuthUser } | { ok: false; status: number; error: string };

/** Extract the bearer token from the Authorization header (or ''). */
export function bearerToken(req: ApiRequest): string {
  const header = req.headers['authorization'];
  const match = typeof header === 'string' ? BEARER.exec(header) : null;
  return match?.[1]?.trim() ?? '';
}

/**
 * Authenticate the request against the sessions table. Returns the resolved
 * user on success, or a 401/401 result otherwise.
 */
export async function requireSession(req: ApiRequest, db: Db): Promise<AuthResult> {
  const token = bearerToken(req);
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: 'Missing bearer token. Log in first with "grace login".',
    };
  }
  const user = await new AuthService(db).authenticate(token);
  if (!user) {
    return {
      ok: false,
      status: 401,
      error: 'Invalid or expired session token. Log in again with "grace login".',
    };
  }
  return { ok: true, user };
}
