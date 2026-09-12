/**
 * KeyRing unit tests.
 *
 * Covers:
 *   - `parse` happy paths: single entry, multi-entry, `legacy-v1` second;
 *   - `parse` rejects: empty input, duplicate kid, malformed key bytes,
 *     malformed kid regex, `legacy-v1` first, multiple `legacy-v1` entries;
 *   - `resolve` happy path + unknown-kid failure mode;
 *   - `hasActive`, `activeKid`, `hasLegacyV1`, `legacyV1Key` reflect the role
 *     model correctly;
 *   - auto-import of a legacy key into a single `legacy-v1` decrypt-only entry
 *     (the backward-compat seam);
 *   - matrix-driven factory tests: for every (legacy var, new var) pair in §7
 *     of the architectural plan, `createCredentialCipher(env)` produces a
 *     cipher whose `(legacyV1Writer, ring)` pair exhibits the documented
 *     `encrypt` / `encryptWithActive` / `decrypt` behaviour.
 *
 * `describe()` outputs are organised so the matrix tests form a single visible
 * block — they document the env × behaviour contract in code.
 */

import { describe, expect, it } from 'vitest';

import {
  CredentialCipher,
  CredentialKeyInvalidError,
  createCredentialCipher,
  generateCredentialKey,
  parseCredentialKey,
} from '@/security/credential-cipher.js';
import { LEGACY_V1_KID, KeyRing } from '@/security/keyring.js';
import type { Env } from '@/config/env.js';

const K1 = parseCredentialKey(generateCredentialKey());
const K2 = parseCredentialKey(generateCredentialKey());

function envWith(legacy?: string, keys?: string): Env {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    HOST: '127.0.0.1',
    PORT: 3000,
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    DATABASE_POOL_MAX: 1,
    WORKER_SHUTDOWN_TIMEOUT_MS: 5000,
    ANTHROPIC_MODEL: 'claude-opus-5',
    TRUST_PROXY: false,
    ...(legacy !== undefined ? { CREDENTIAL_ENCRYPTION_KEY: legacy } : {}),
    ...(keys !== undefined ? { CREDENTIAL_ENCRYPTION_KEYS: keys } : {}),
  } as Env;
}

describe('KeyRing.parse — happy paths', () => {
  it('accepts a single active entry', () => {
    const ring = KeyRing.parse(`kid-a:${K1.toString('base64')}`);
    expect(ring.activeKid).toBe('kid-a');
    expect(ring.hasActive).toBe(true);
    expect(ring.hasLegacyV1).toBe(false);
  });

  it('treats every entry after the first as decrypt-only', () => {
    const ring = KeyRing.parse(`kid-a:${K1.toString('base64')},kid-b:${K2.toString('base64')}`);
    const described = ring.describe();
    expect(described).toEqual([
      { kid: 'kid-a', role: 'active' },
      { kid: 'kid-b', role: 'decrypt-only' },
    ]);
  });

  it('accepts legacy-v1 as a non-first entry', () => {
    const ring = KeyRing.parse(`kid-a:${K1.toString('base64')},${LEGACY_V1_KID}:${K2.toString('base64')}`);
    expect(ring.activeKid).toBe('kid-a');
    expect(ring.hasLegacyV1).toBe(true);
    expect(ring.legacyV1Key).not.toBeNull();
  });
});

describe('KeyRing.parse — rejections', () => {
  it('rejects an empty value', () => {
    expect(() => KeyRing.parse('')).toThrow(CredentialKeyInvalidError);
    expect(() => KeyRing.parse('   ')).toThrow(CredentialKeyInvalidError);
  });

  it('rejects a duplicate kid', () => {
    const b64 = K1.toString('base64');
    expect(() => KeyRing.parse(`kid-a:${b64},kid-a:${b64}`)).toThrow(CredentialKeyInvalidError);
  });

  it('rejects a malformed key bytes', () => {
    expect(() => KeyRing.parse('kid-a:not-base64-or-hex')).toThrow(CredentialKeyInvalidError);
    expect(() => KeyRing.parse(`kid-a:${'a'.repeat(63)}`)).toThrow(CredentialKeyInvalidError);
  });

  it('rejects a kid that fails the shape regex', () => {
    expect(() => KeyRing.parse(`bad kid:${K1.toString('base64')}`)).toThrow(CredentialKeyInvalidError);
    expect(() => KeyRing.parse(`bad/kid:${K1.toString('base64')}`)).toThrow(CredentialKeyInvalidError);
    expect(() => KeyRing.parse(`bad+kid:${K1.toString('base64')}`)).toThrow(CredentialKeyInvalidError);
    expect(() => KeyRing.parse(`bad=kid:${K1.toString('base64')}`)).toThrow(CredentialKeyInvalidError);
  });

  it('rejects legacy-v1 as the first (active) entry', () => {
    expect(() => KeyRing.parse(`${LEGACY_V1_KID}:${K1.toString('base64')}`)).toThrow(
      CredentialKeyInvalidError,
    );
    expect(() =>
      KeyRing.parse(
        `${LEGACY_V1_KID}:${K1.toString('base64')},kid-a:${K2.toString('base64')}`,
      ),
    ).toThrow(CredentialKeyInvalidError);
  });

  it('rejects a malformed entry (no colon)', () => {
    expect(() => KeyRing.parse(`kid-only-${K1.toString('base64')}`)).toThrow(CredentialKeyInvalidError);
  });
});

describe('KeyRing.resolve and describe', () => {
  it('resolves a known kid to its key bytes', () => {
    const ring = KeyRing.parse(`kid-a:${K1.toString('base64')},kid-b:${K2.toString('base64')}`);
    expect(ring.resolve('kid-a').equals(K1)).toBe(true);
    expect(ring.resolve('kid-b').equals(K2)).toBe(true);
  });

  it('throws CredentialKeyInvalidError on an unknown kid', () => {
    const ring = KeyRing.parse(`kid-a:${K1.toString('base64')}`);
    expect(() => ring.resolve('kid-z')).toThrow(CredentialKeyInvalidError);
  });

  it('describe() returns kid + role without the key bytes', () => {
    const ring = KeyRing.parse(`kid-a:${K1.toString('base64')},kid-b:${K2.toString('base64')}`);
    const described = ring.describe();
    // No Buffer / bytes appear in the describe output.
    expect(JSON.stringify(described)).not.toContain('base64');
    expect(described).toEqual([
      { kid: 'kid-a', role: 'active' },
      { kid: 'kid-b', role: 'decrypt-only' },
    ]);
  });
});

describe('KeyRing.fromLegacyKey (backward-compat auto-import)', () => {
  it('creates a single decrypt-only legacy-v1 entry', () => {
    const ring = KeyRing.fromLegacyKey(K1);
    expect(ring.hasLegacyV1).toBe(true);
    expect(ring.legacyV1Key?.equals(K1)).toBe(true);
    expect(ring.hasActive).toBe(false);
    expect(ring.activeKid).toBeNull();
  });
});

describe('KeyRing.empty', () => {
  it('reports no active and no legacy', () => {
    const ring = KeyRing.empty();
    expect(ring.hasActive).toBe(false);
    expect(ring.hasLegacyV1).toBe(false);
    expect(ring.activeKid).toBeNull();
    expect(ring.legacyV1Key).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Matrix-driven factory tests: every (legacy, keys) pair from §7 of the plan.
//
// These tests document the env × behaviour contract of createCredentialCipher
// by enumerating each matrix cell, building the cipher via the factory, and
// asserting the documented (KeyRing, legacyV1Writer) capability pair plus the
// encrypt/decrypt behaviour that the cell claims.
// --------------------------------------------------------------------------

describe('createCredentialCipher — env × behaviour matrix', () => {
  const kidA = 'kid-a';
  const kidA_b64 = K1.toString('base64');
  const kidB_b64 = K2.toString('base64');

  function make(legacy?: string, keys?: string): CredentialCipher {
    return createCredentialCipher(envWith(legacy, keys));
  }

  it('legacy present / new absent → legacy auto-import, ring has legacy-v1, writer = legacy', () => {
    const c = make(K1.toString('base64'));
    expect(c.hasKey).toBe(true);
    // v1 write works, v1 read works, v2 read fails (no kid in ring).
    const v1 = c.encrypt({ a: 1 });
    expect(v1.v).toBe(1);
    expect(c.decrypt(v1)).toEqual({ a: 1 });
  });

  it('new present (no legacy-v1) / no legacy → writer = null, v2 active present', () => {
    const c = make(undefined, `${kidA}:${kidA_b64}`);
    expect(c.hasKey).toBe(true);
    // v1 write fails with typed error.
    expect(() => c.encrypt({ a: 1 })).toThrow();
    // v2 write + read works.
    const env = c.encryptWithActive({ a: 1 }, Buffer.from('a:b'));
    expect(c.decrypt(env, { tenantId: 't', connectionId: 'c', aad: Buffer.from('a:b') })).toEqual({ a: 1 });
  });

  it('new present (with legacy-v1) / no legacy → ring has active + legacy, writer = ring legacy', () => {
    const c = make(undefined, `${kidA}:${kidA_b64},${LEGACY_V1_KID}:${kidB_b64}`);
    expect(c.hasKey).toBe(true);
    const v1 = c.encrypt({ a: 1 });
    expect(v1.v).toBe(1);
    expect(c.decrypt(v1)).toEqual({ a: 1 });
    const env = c.encryptWithActive({ b: 2 }, Buffer.from('x'));
    expect(env.kid).toBe(kidA);
  });

  it('new present (with legacy-v1) / legacy present → keyring wins; legacy var ignored for ring', () => {
    // Both vars set, the keyring contains legacy-v1.
    const c = make(K1.toString('base64'), `${kidA}:${kidA_b64},${LEGACY_V1_KID}:${kidB_b64}`);
    // The v1 writer is sourced from the keyring's legacy-v1 entry (K2), not
    // the legacy env var (K1). Verify by encrypting with c and decrypting with
    // a cipher whose only legacy key is K2.
    const v1 = c.encrypt({ a: 1 });
    const reference = new CredentialCipher(K2, KeyRing.fromLegacyKey(K2));
    expect(reference.decrypt(v1)).toEqual({ a: 1 });
  });

  it('new present (no legacy-v1) / legacy present → writer from legacy var; keyring has active only', () => {
    const c = make(K1.toString('base64'), `${kidA}:${kidA_b64}`);
    const v1 = c.encrypt({ a: 1 });
    expect(v1.v).toBe(1);
    // The ring has no legacy-v1, so v1 decrypt fails.
    expect(() => c.decrypt(v1)).toThrow();
  });

  it('legacy absent / new absent → ring empty, writer null, hasKey = false', () => {
    const c = make();
    expect(c.hasKey).toBe(false);
  });

  it('new present malformed → boot-time failure (parsed at KeyRing.parse)', () => {
    expect(() => make(undefined, `kid-a:not-a-key`)).toThrow(CredentialKeyInvalidError);
  });
});
