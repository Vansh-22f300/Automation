/**
 * Unit tests for the session-token primitives (`@/auth/session-token`).
 *
 * These pin what makes a session token safe *before* any storage or lookup: it
 * is a high-entropy, transport-safe, opaque string (no tenant/user/expiry
 * encoded — just 256 random bits), every mint is distinct, and the stored
 * digest is a deterministic one-way SHA-256 hex that never reveals the token.
 */

import { describe, expect, it } from 'vitest';

import {
  generateSessionToken,
  hashSessionToken,
  SESSION_TOKEN_BYTES,
} from '@/auth/session-token.js';

describe('generateSessionToken', () => {
  it('produces a non-empty, url-safe (base64url) token', () => {
    const token = generateSessionToken();
    expect(token.length).toBeGreaterThan(0);
    // base64url alphabet only: safe in a cookie or Authorization header.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('carries the full 256 bits of CSPRNG entropy and nothing more', () => {
    // Decoding back to exactly SESSION_TOKEN_BYTES random bytes is the evidence
    // that the token is pure randomness — there is no room for an encoded
    // tenant id, user id, or expiry to smuggle in.
    const raw = Buffer.from(generateSessionToken(), 'base64url');
    expect(raw.length).toBe(SESSION_TOKEN_BYTES);
  });

  it('mints a distinct, unpredictable token on every call', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateSessionToken()));
    expect(tokens.size).toBe(1000);
  });
});

describe('hashSessionToken', () => {
  it('is deterministic and hex-encoded (SHA-256)', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('maps different tokens to different digests', () => {
    expect(hashSessionToken(generateSessionToken())).not.toBe(
      hashSessionToken(generateSessionToken()),
    );
  });

  it('never exposes the plaintext token in its digest', () => {
    const token = generateSessionToken();
    const digest = hashSessionToken(token);
    expect(digest).not.toBe(token);
    expect(digest).not.toContain(token);
  });
});
