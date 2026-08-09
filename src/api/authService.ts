/**
 * Authentication service (Milestone 11).
 *
 * DB-backed account + session operations: register, login, logout and
 * authenticate (resolve a bearer token to a user). Used by both the API
 * handlers and the tests. Passwords are scrypt-hashed (src/api/password.ts);
 * sessions store only the SHA-256 of the token (src/api/sessions.ts).
 */
import type { Db } from './db.ts';
import { hashPassword, verifyPassword } from './password.ts';
import { generateSessionToken, hashSessionToken } from './sessions.ts';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface SessionResult {
  user: AuthUser;
  /** Raw token — only ever returned once, at login/register time. */
  token: string;
  /** ISO timestamp after which the session is rejected. */
  expiresAt: string;
}

/** A 4xx/5xx auth error carrying an HTTP status. */
export class AuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Sessions live 30 days. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** Create an account and an initial session. */
  async register(
    input: { email: string; password: string; displayName?: string | null },
    device = 'cli',
    opts: { beta?: boolean } = {},
  ): Promise<SessionResult> {
    const email = normalizeEmail(input.email);
    if (!email) throw new AuthError(400, '"email" must be a valid email address.');
    const password = input.password ?? '';
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new AuthError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    const displayName =
      typeof input.displayName === 'string' && input.displayName.trim() ? input.displayName.trim() : null;

    const existing = await this.db('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.length > 0) throw new AuthError(409, 'An account with this email already exists.');

    // Milestone 12: beta testers are flagged on the account (users.is_beta).
    const inserted = opts.beta
      ? await this.db(
          'INSERT INTO users (email, display_name, password_hash, is_beta) VALUES ($1, $2, $3, $4) RETURNING id',
          [email, displayName, hashPassword(password), true],
        )
      : await this.db(
          'INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
          [email, displayName, hashPassword(password)],
        );
    const userId = String(inserted[0]?.id ?? '');
    if (!userId) throw new AuthError(500, 'Could not create the account.');

    return this.createSession({ id: userId, email, displayName }, device);
  }

  /** Verify credentials and open a new session. */
  async login(input: { email: string; password: string }, device = 'cli'): Promise<SessionResult> {
    const email = normalizeEmail(input.email);
    if (!email || !input.password) throw new AuthError(400, '"email" and "password" are required.');
    const rows = await this.db('SELECT id, email, display_name, password_hash FROM users WHERE email = $1', [email]);
    const row = rows[0];
    if (!row) throw new AuthError(401, 'Invalid email or password.');

    const stored = String(row.password_hash ?? '');
    if (!stored || !verifyPassword(input.password, stored)) {
      throw new AuthError(401, 'Invalid email or password.');
    }
    return this.createSession(
      {
        id: String(row.id),
        email: String(row.email),
        displayName: row.display_name == null ? null : String(row.display_name),
      },
      device,
    );
  }

  /** Invalidate a session. Returns false when the token was not found. */
  async logout(token: string): Promise<boolean> {
    if (!token) return false;
    await this.db('DELETE FROM sessions WHERE token_hash = $1', [hashSessionToken(token)]);
    return true;
  }

  /** Resolve a raw bearer token to a user, or null when invalid/expired. */
  async authenticate(token: string): Promise<AuthUser | null> {
    if (!token) return null;
    const rows = await this.db(
      `SELECT u.id, u.email, u.display_name, s.expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [hashSessionToken(token)],
    );
    const row = rows[0];
    if (!row) return null;
    const expiresAt = new Date(String(row.expires_at));
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) return null;
    return {
      id: String(row.id),
      email: String(row.email),
      displayName: row.display_name == null ? null : String(row.display_name),
    };
  }

  private async createSession(user: AuthUser, device: string): Promise<SessionResult> {
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await this.db('INSERT INTO sessions (user_id, token_hash, device, expires_at) VALUES ($1, $2, $3, $4)', [
      user.id,
      hashSessionToken(token),
      device,
      expiresAt,
    ]);
    return { user, token, expiresAt };
  }
}

/** Normalize + validate an email ('' when invalid). Shared with the handlers. */
export function normalizeEmail(email: unknown): string {
  if (typeof email !== 'string') return '';
  const trimmed = email.trim().toLowerCase();
  return EMAIL_RE.test(trimmed) ? trimmed : '';
}
