/**
 * Session tokens (Milestone 11).
 *
 * The raw token (64 hex chars from a CSPRNG) is handed to the client once and
 * never stored server-side. The database keeps only `SHA-256(token)` in
 * sessions.token_hash, so a leaked database cannot be replayed as sessions.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Generate a fresh opaque session token (64 hex chars). */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/** The only representation of a token that is stored or compared server-side. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
