/**
 * Unit tests for the Argon2id password hasher (`@/auth/password`).
 *
 * These pin the security invariants of the KDF with no storage in play: the
 * output is an Argon2id PHC string, the plaintext never appears in it, equal
 * passwords hash to *different* strings (a fresh random salt each time), the
 * right password verifies and a wrong one does not, and a malformed or foreign
 * stored hash fails closed instead of throwing.
 */

import { describe, expect, it } from 'vitest';

import { argon2PasswordHasher } from '@/auth/password.js';

const { hash, verify } = argon2PasswordHasher;

describe('argon2PasswordHasher.hash', () => {
  it('produces a non-empty Argon2id PHC hash', async () => {
    const digest = await hash('correct horse battery staple');
    expect(digest.length).toBeGreaterThan(0);
    // The `$argon2id$` marker pins the algorithm regardless of library defaults.
    expect(digest.startsWith('$argon2id$')).toBe(true);
  });

  it('never embeds the plaintext password in the hash', async () => {
    const password = 'sup3r-secret-passphrase';
    const digest = await hash(password);
    expect(digest).not.toContain(password);
  });

  it('produces a different hash each call for the same password (random salt)', async () => {
    const password = 'same-password-twice';
    const [a, b] = await Promise.all([hash(password), hash(password)]);
    expect(a).not.toBe(b);
  });
});

describe('argon2PasswordHasher.verify', () => {
  it('accepts the correct password', async () => {
    const password = 'right-password';
    const digest = await hash(password);
    expect(await verify(digest, password)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const digest = await hash('right-password');
    expect(await verify(digest, 'wrong-password')).toBe(false);
  });

  it('returns false for a malformed or foreign stored hash rather than throwing', async () => {
    expect(await verify('not-a-real-argon2-hash', 'whatever')).toBe(false);
    expect(await verify('', 'whatever')).toBe(false);
    // A SHA-256-shaped api-key hash must never verify as a password hash.
    expect(await verify('a'.repeat(64), 'whatever')).toBe(false);
  });
});
