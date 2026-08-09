/**
 * Password hashing (Milestone 11).
 *
 * Uses Node's built-in `scrypt` with a random per-user salt. Only the salted
 * hash is ever stored (users.password_hash) — plaintext passwords never touch
 * the database, the logs, or the API responses. Verification compares digests
 * in constant time via `timingSafeEqual`.
 *
 * Stored format: "<salt-hex>:<hash-hex>"
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LEN = 64;
const SALT_BYTES = 16;

/** Hash a password into the "salt:hash" storage format. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const hash = scryptSync(password, salt, KEY_LEN).toString('hex');
  return `${salt}:${hash}`;
}

/** Constant-time password check against a stored "salt:hash" value. */
export function verifyPassword(password: string, stored: string): boolean {
  const sep = stored.indexOf(':');
  if (sep <= 0) return false;
  const salt = stored.slice(0, sep);
  const hashHex = stored.slice(sep + 1);
  if (!salt || !hashHex) return false;

  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, KEY_LEN);
  } catch {
    return false;
  }
  const expected = Buffer.from(hashHex, 'hex');
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
