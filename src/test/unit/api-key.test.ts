/**
 * Unit tests for the API-key cryptography primitives.
 *
 * These pin the security invariants of `@/auth/api-key` with no storage and no
 * HTTP in play: keys are high-entropy and prefixed, the plaintext is returned
 * but never part of the storable material, hashing is stable, parsing rejects
 * anything foreign, and verification is by hash (so the plaintext is never
 * needed to check a key again).
 */

import { describe, expect, it } from 'vitest';

import {
  API_KEY_PREFIX,
  generateApiKey,
  hashSecret,
  parseApiKey,
  verifySecret,
} from '@/auth/api-key.js';

describe('generateApiKey', () => {
  it('mints a prefixed, high-entropy plaintext key', () => {
    const key = generateApiKey();

    expect(key.plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
    // 32 bytes base64url ≈ 43 chars, plus the marker.
    expect(key.plaintext.length).toBeGreaterThan(API_KEY_PREFIX.length + 40);
    expect(key.plaintext.slice(API_KEY_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces a distinct key every call', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateApiKey().plaintext));
    expect(keys.size).toBe(100);
  });

  it('never puts the plaintext in the storable material', () => {
    const key = generateApiKey();

    // The material a caller would persist is {prefix, keyHash}. Prove the
    // plaintext (and its secret half) is absent from both.
    const secret = key.plaintext.slice(API_KEY_PREFIX.length);
    expect(key.keyHash).not.toContain(secret);
    expect(key.keyHash).not.toContain(key.plaintext);
    // The stored hash is a 64-char hex SHA-256 digest, not the secret.
    expect(key.keyHash).toMatch(/^[0-9a-f]{64}$/);
    // The prefix is a short, non-secret head of the secret.
    expect(secret.startsWith(key.prefix)).toBe(true);
    expect(key.prefix.length).toBeLessThan(secret.length);
  });

  it('stores a hash that verifies against the issued secret', () => {
    const key = generateApiKey();
    const secret = key.plaintext.slice(API_KEY_PREFIX.length);

    expect(verifySecret(secret, key.keyHash)).toBe(true);
  });
});

describe('hashSecret', () => {
  it('is deterministic and hex-encoded', () => {
    expect(hashSecret('abc')).toBe(hashSecret('abc'));
    expect(hashSecret('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different inputs', () => {
    expect(hashSecret('abc')).not.toBe(hashSecret('abd'));
  });
});

describe('parseApiKey', () => {
  it('splits a well-formed key into secret and prefix', () => {
    const key = generateApiKey();
    const parsed = parseApiKey(key.plaintext);

    expect(parsed).not.toBeNull();
    expect(parsed!.prefix).toBe(key.prefix);
    expect(API_KEY_PREFIX + parsed!.secret).toBe(key.plaintext);
  });

  it('rejects anything without our marker', () => {
    expect(parseApiKey('nope_deadbeefdeadbeef')).toBeNull();
    expect(parseApiKey('')).toBeNull();
    expect(parseApiKey('Bearer something')).toBeNull();
  });

  it('rejects a key whose secret is too short to hold a prefix', () => {
    expect(parseApiKey(API_KEY_PREFIX + 'short')).toBeNull();
  });

  it('rejects non-base64url characters in the secret', () => {
    expect(parseApiKey(API_KEY_PREFIX + 'has spaces and !!!')).toBeNull();
    expect(parseApiKey(API_KEY_PREFIX + 'contains/slash+plus====')).toBeNull();
  });
});

describe('verifySecret', () => {
  it('accepts the matching secret and rejects a wrong one', () => {
    const key = generateApiKey();
    const secret = key.plaintext.slice(API_KEY_PREFIX.length);

    expect(verifySecret(secret, key.keyHash)).toBe(true);
    expect(verifySecret(secret + 'x', key.keyHash)).toBe(false);
    expect(verifySecret('totally-different', key.keyHash)).toBe(false);
  });

  it('returns false for a malformed stored hash rather than throwing', () => {
    expect(verifySecret('anything', 'not-hex-!!')).toBe(false);
    expect(verifySecret('anything', '')).toBe(false);
  });
});
