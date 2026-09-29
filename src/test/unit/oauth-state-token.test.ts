/**
 * Unit tests for the OAuth `state` value and its at-rest hash
 * (`@/oauth/state-token`). The raw state is the CSRF token that travels in the
 * authorize URL and comes back in the callback query; only its SHA-256 hex digest
 * is ever persisted. These pin both halves: the value is high-entropy base64url,
 * and the hash is a deterministic, one-way, lowercase-hex SHA-256.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { generateOAuthState, hashOAuthState } from '@/oauth/state-token.js';

describe('generateOAuthState', () => {
  it('mints a 43-char base64url state (256 bits of entropy)', () => {
    const state = generateOAuthState();
    expect(state).toHaveLength(43);
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(state).not.toContain('=');
  });

  it('is unguessable — 100 mints are all distinct', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateOAuthState()));
    expect(seen.size).toBe(100);
  });
});

describe('hashOAuthState', () => {
  it('is lowercase-hex SHA-256 — the "abc" known-answer vector', () => {
    expect(hashOAuthState('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is deterministic, 64 hex chars, and matches an independent digest', () => {
    const state = generateOAuthState();
    const expected = createHash('sha256').update(state).digest('hex');
    expect(hashOAuthState(state)).toBe(expected);
    expect(hashOAuthState(state)).toBe(hashOAuthState(state));
    expect(hashOAuthState(state)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('maps distinct states to distinct hashes', () => {
    expect(hashOAuthState(generateOAuthState())).not.toBe(hashOAuthState(generateOAuthState()));
  });
});
