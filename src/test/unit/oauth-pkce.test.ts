/**
 * Unit tests for the PKCE primitives (`@/oauth/pkce`). Pure functions over
 * `node:crypto`; no I/O. They pin the two properties the flow depends on: the
 * verifier is high-entropy and unreserved-charset, and the challenge is exactly
 * `base64url(SHA-256(verifier))` with method `S256` — proven against the RFC 7636
 * Appendix B known-answer vector so a future refactor cannot silently change it.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CODE_CHALLENGE_METHOD, deriveCodeChallenge, generateCodeVerifier } from '@/oauth/pkce.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe('generateCodeVerifier', () => {
  it('mints a 43-char base64url verifier (256 bits, unreserved charset, no padding)', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(BASE64URL);
    expect(verifier).not.toContain('=');
  });

  it('is unguessable — two mints never collide', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateCodeVerifier()));
    expect(seen.size).toBe(100);
  });
});

describe('deriveCodeChallenge', () => {
  it('is base64url(SHA-256(verifier)) — the RFC 7636 Appendix B vector', () => {
    // The canonical known-answer pair from the spec; a byte-for-byte guard.
    expect(deriveCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('is deterministic and matches an independent digest', () => {
    const verifier = generateCodeVerifier();
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(deriveCodeChallenge(verifier)).toBe(expected);
    expect(deriveCodeChallenge(verifier)).toBe(deriveCodeChallenge(verifier));
    expect(deriveCodeChallenge(verifier)).toHaveLength(43);
    expect(deriveCodeChallenge(verifier)).toMatch(BASE64URL);
  });

  it('is only ever the S256 method — never plain', () => {
    expect(CODE_CHALLENGE_METHOD).toBe('S256');
  });
});
