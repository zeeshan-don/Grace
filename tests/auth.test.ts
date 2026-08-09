import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AuthError, AuthService } from '../src/api/authService.ts';
import { hashPassword, verifyPassword } from '../src/api/password.ts';
import { RateLimiter } from '../src/api/rateLimit.ts';
import { generateSessionToken, hashSessionToken } from '../src/api/sessions.ts';
import { createMemoryDb } from './helpers/memoryDb.ts';

afterEach(() => {
  // nothing global to reset here, but keep parity with the other suites
});

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

test('hashPassword stores a salted scrypt hash, never the plaintext', () => {
  const stored = hashPassword('s3cret-password');
  assert.ok(stored.includes(':'), 'format is salt:hash');
  assert.ok(!stored.includes('s3cret-password'), 'plaintext never appears');
  assert.ok(verifyPassword('s3cret-password', stored));
});

test('verifyPassword rejects wrong passwords and malformed stores', () => {
  const stored = hashPassword('right-password');
  assert.ok(!verifyPassword('wrong-password', stored));
  assert.ok(!verifyPassword('right-password', ''));
  assert.ok(!verifyPassword('right-password', 'no-colon-here'));
  assert.ok(!verifyPassword('right-password', 'saltonly:'));
});

test('same password hashes to different values (random salts)', () => {
  const a = hashPassword('same-password');
  const b = hashPassword('same-password');
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

test('session tokens are random, long and only stored hashed', () => {
  const token = generateSessionToken();
  assert.equal(token.length, 64);
  assert.match(token, /^[0-9a-f]{64}$/);

  const hash = hashSessionToken(token);
  assert.equal(hash.length, 64);
  assert.notEqual(hash, token, 'hash must differ from the raw token');
  assert.equal(hashSessionToken(token), hash, 'hashing is deterministic');
});

// ---------------------------------------------------------------------------
// AuthService (register / login / logout / authenticate)
// ---------------------------------------------------------------------------

test('AuthService registers a user, stores a hash and returns a session', async () => {
  const mem = createMemoryDb();
  const svc = new AuthService(mem.db);

  const result = await svc.register({ email: 'Dev@Example.com', password: 'hunter2-strong' }, 'test');
  assert.ok(result.token);
  assert.ok(result.expiresAt);
  assert.equal(result.user.email, 'dev@example.com', 'email is normalized');
  assert.equal(result.user.displayName, null);

  // password stored as a hash, not plaintext
  const stored = mem.users[0];
  assert.ok(stored?.password_hash);
  assert.ok(!stored?.password_hash?.includes('hunter2-strong'));
  // session stores the hash, not the token
  assert.equal(mem.sessions[0]?.token_hash, hashSessionToken(result.token));
});

test('AuthService rejects weak passwords and invalid emails', async () => {
  const svc = new AuthService(createMemoryDb().db);
  await assert.rejects(
    () => svc.register({ email: 'a@b.com', password: 'short' }),
    (err: unknown) => err instanceof AuthError && err.status === 400,
  );
  await assert.rejects(
    () => svc.register({ email: 'not-an-email', password: 'long-enough-pass' }),
    (err: unknown) => err instanceof AuthError && err.status === 400,
  );
});

test('AuthService rejects duplicate emails with 409', async () => {
  const svc = new AuthService(createMemoryDb().db);
  await svc.register({ email: 'a@b.com', password: 'long-enough-pass' });
  await assert.rejects(
    () => svc.register({ email: 'a@b.com', password: 'another-long-pass' }),
    (err: unknown) => err instanceof AuthError && err.status === 409,
  );
});

test('AuthService logs in with the right password and rejects the wrong one', async () => {
  const mem = createMemoryDb();
  const svc = new AuthService(mem.db);
  await svc.register({ email: 'a@b.com', password: 'long-enough-pass' });

  const ok = await svc.login({ email: 'A@B.com', password: 'long-enough-pass' }, 'test');
  assert.equal(ok.user.email, 'a@b.com');
  assert.ok(ok.token);

  await assert.rejects(
    () => svc.login({ email: 'a@b.com', password: 'wrong-password' }),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
  await assert.rejects(
    () => svc.login({ email: 'nobody@b.com', password: 'long-enough-pass' }),
    (err: unknown) => err instanceof AuthError && err.status === 401,
  );
});

test('AuthService authenticate resolves valid tokens and rejects unknown/expired ones', async () => {
  const mem = createMemoryDb();
  const svc = new AuthService(mem.db);
  const { token, user } = await svc.register({ email: 'a@b.com', password: 'long-enough-pass' });

  const resolved = await svc.authenticate(token);
  assert.deepEqual(resolved, user);

  assert.equal(await svc.authenticate('not-a-real-token'), null);
  assert.equal(await svc.authenticate(''), null);

  // expired session → null
  const expired = await svc.register({ email: 'expired@b.com', password: 'long-enough-pass' }, 'test');
  mem.sessions[1]!.expires_at = new Date(Date.now() - 1000).toISOString();
  assert.equal(await svc.authenticate(expired.token), null);
});

test('AuthService logout invalidates the session', async () => {
  const mem = createMemoryDb();
  const svc = new AuthService(mem.db);
  const { token } = await svc.register({ email: 'a@b.com', password: 'long-enough-pass' });

  assert.ok(await svc.authenticate(token));
  await svc.logout(token);
  assert.equal(await svc.authenticate(token), null);
  assert.equal(mem.sessions.length, 0);
});

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------

test('RateLimiter allows up to the max and then blocks with retry-after', () => {
  const limiter = new RateLimiter(60_000, 3);
  assert.equal(limiter.check('ip:1').ok, true);
  assert.equal(limiter.check('ip:1').ok, true);
  assert.equal(limiter.check('ip:1').ok, true);
  const blocked = limiter.check('ip:1');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSeconds >= 1);

  // different key is unaffected
  assert.equal(limiter.check('ip:2').ok, true);
});

test('RateLimiter.reset clears state', () => {
  const limiter = new RateLimiter(60_000, 1);
  assert.equal(limiter.check('k').ok, true);
  assert.equal(limiter.check('k').ok, false);
  limiter.reset();
  assert.equal(limiter.check('k').ok, true);
});

test('RateLimiter forgets old hits after the window elapses', () => {
  const limiter = new RateLimiter(1_000, 1);
  assert.equal(limiter.check('k').ok, true);
  // Simulate time passing: the window is 1s, wait for it.
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(limiter.check('k').ok, true);
      resolve();
    }, 1_100);
  });
});
