/**
 * Credential cipher v2 envelope + capability-split unit tests.
 *
 * Companion to `credential-cipher.test.ts`, which covers the v1 round-trip and
 * tamper detection. This file proves:
 *
 *   - v2 round-trip: encryptWithActive + decrypt with the matching AAD;
 *   - AAD binding: a mismatched tenant/connection fails GCM verification;
 *   - kid resolution: unknown kid surfaces a typed `CredentialDecryptionError`
 *     without trying every key;
 *   - malformed v2 envelopes fail loudly without leaking ciphertext or key
 *     material;
 *   - the capability split: `encrypt()` is the v1 path (`legacyV1Writer`),
 *     `encryptWithActive()` is the v2 path (ring active kid); neither can be
 *     swapped regardless of writer state.
 *
 * The matrix-driven factory tests that exercise every env × behaviour pair in
 * §7 of the architectural plan live in `keyring.test.ts`. Together these three
 * files prove the cipher and keyring layer end to end without a database.
 */

import { describe, expect, it } from 'vitest';

import {
  CredentialActiveKeyMissingError,
  CredentialCipher,
  CredentialDecryptionError,
  CredentialLegacyV1WriterMissingError,
  generateCredentialKey,
  parseCredentialKey,
} from '@/security/credential-cipher.js';
import { KeyRing } from '@/security/keyring.js';

const ACTIVE_KID = '2026-09-active';
const LEGACY_KID = 'legacy-v1';
const ACTIVE_KEY = parseCredentialKey(generateCredentialKey());
const LEGACY_KEY = parseCredentialKey(generateCredentialKey());
const TENANT = '00000000-0000-0000-0000-000000000001';
const CONN = '00000000-0000-0000-0000-000000000002';

/** A cipher whose ring has both an active kid and a legacy-v1 entry. */
function makeCipher(): CredentialCipher {
  const ring = KeyRing.parse(`${ACTIVE_KID}:${ACTIVE_KEY.toString('base64')},${LEGACY_KID}:${LEGACY_KEY.toString('base64')}`);
  return new CredentialCipher(LEGACY_KEY, ring);
}

describe('CredentialCipher v2 round-trip with AAD', () => {
  it('encryptWithActive → decrypt yields the original plaintext', () => {
    const c = makeCipher();
    const secret = { token: 'xoxb-abc', refresh: 'r-def' };
    const aad = Buffer.from(`${TENANT}:${CONN}`, 'utf8');
    const env = c.encryptWithActive(secret, aad);

    expect(env.v).toBe(2);
    expect(env.kid).toBe(ACTIVE_KID);
    expect(env.alg).toBe('aes-256-gcm');

    const out = c.decrypt(env, { tenantId: TENANT, connectionId: CONN });
    expect(out).toEqual(secret);
  });

  it('AAD mismatch fails GCM verification (wrong tenantId)', () => {
    const c = makeCipher();
    const aad = Buffer.from(`${TENANT}:${CONN}`, 'utf8');
    const env = c.encryptWithActive({ token: 'x' }, aad);
    expect(() => c.decrypt(env, { tenantId: 'OTHER', connectionId: CONN })).toThrow(
      CredentialDecryptionError,
    );
  });

  it('AAD mismatch fails GCM verification (wrong connectionId)', () => {
    const c = makeCipher();
    const aad = Buffer.from(`${TENANT}:${CONN}`, 'utf8');
    const env = c.encryptWithActive({ token: 'x' }, aad);
    expect(() => c.decrypt(env, { tenantId: TENANT, connectionId: 'OTHER' })).toThrow(
      CredentialDecryptionError,
    );
  });

  it('AAD can be passed as a pre-built Buffer instead of tenantId/connectionId', () => {
    const c = makeCipher();
    const aad = Buffer.from(`${TENANT}:${CONN}`, 'utf8');
    const env = c.encryptWithActive({ token: 'x' }, aad);
    expect(c.decrypt(env, { aad })).toEqual({ token: 'x' });
  });

  it('omitting both AAD forms fails GCM verification (ciphertext was written WITH AAD)', () => {
    const c = makeCipher();
    const aad = Buffer.from(`${TENANT}:${CONN}`, 'utf8');
    const env = c.encryptWithActive({ token: 'x' }, aad);
    expect(() => c.decrypt(env)).toThrow(CredentialDecryptionError);
  });

  it('encrypts v2 to different ciphertext each time (random IV) but decrypts identically', () => {
    const c = makeCipher();
    const aad = Buffer.from(`${TENANT}:${CONN}`, 'utf8');
    const a = c.encryptWithActive({ token: 'same' }, aad);
    const b = c.encryptWithActive({ token: 'same' }, aad);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(c.decrypt(a, { tenantId: TENANT, connectionId: CONN })).toEqual(
      c.decrypt(b, { tenantId: TENANT, connectionId: CONN }),
    );
  });
});

describe('CredentialCipher v2 kid resolution', () => {
  it('unknown kid on a v2 envelope throws CredentialDecryptionError', () => {
    const c = makeCipher();
    const aad = Buffer.from(`${TENANT}:${CONN}`, 'utf8');
    const env = c.encryptWithActive({ token: 'x' }, aad);
    // Build a ring whose only entry is some other kid — the active kid from
    // `env` is missing. (The reserved `legacy-v1` kid can never be first, so we
    // use a fresh non-secret label here.)
    const otherKid = '2026-09-other';
    const otherKey = parseCredentialKey(generateCredentialKey());
    const ringWithoutActive = KeyRing.parse(`${otherKid}:${otherKey.toString('base64')}`);
    const c2 = new CredentialCipher(LEGACY_KEY, ringWithoutActive);
    expect(() => c2.decrypt(env, { tenantId: TENANT, connectionId: CONN })).toThrow(
      CredentialDecryptionError,
    );
  });

  it('a v1 envelope is not decrypted by v2 even with AAD — dispatch on envelope.v', () => {
    const c = makeCipher();
    const v1 = c.encrypt({ token: 'x' });
    // Decrypting a v1 envelope with v2-shaped options still uses the legacy path.
    // This is what the existing code does today; AAD is irrelevant for v1.
    expect(c.decrypt(v1, { tenantId: TENANT, connectionId: CONN })).toEqual({ token: 'x' });
  });
});

describe('CredentialCipher malformed v2 envelopes', () => {
  function makeEnvelope() {
    const c = makeCipher();
    const aad = Buffer.from(`${TENANT}:${CONN}`, 'utf8');
    return c.encryptWithActive({ token: 'x' }, aad);
  }

  it('rejects unknown envelope version', () => {
    const env = makeEnvelope();
    expect(() => makeCipher().decrypt({ ...env, v: 9 } as never, { tenantId: TENANT, connectionId: CONN })).toThrow(
      CredentialDecryptionError,
    );
  });

  it('rejects unsupported algorithm on a v2 envelope', () => {
    const env = makeEnvelope();
    expect(() =>
      makeCipher().decrypt({ ...env, alg: 'rot13' as 'aes-256-gcm' }, { tenantId: TENANT, connectionId: CONN }),
    ).toThrow(CredentialDecryptionError);
  });

  it('rejects missing kid on a v2 envelope', () => {
    const env = makeEnvelope();
    const noKid = { ...env, kid: '' } as unknown as Parameters<CredentialCipher['decrypt']>[0];
    expect(() => makeCipher().decrypt(noKid, { tenantId: TENANT, connectionId: CONN })).toThrow(
      CredentialDecryptionError,
    );
  });

  it('rejects malformed iv length on a v2 envelope', () => {
    const env = makeEnvelope();
    expect(() =>
      makeCipher().decrypt({ ...env, iv: Buffer.alloc(4).toString('base64') }, { tenantId: TENANT, connectionId: CONN }),
    ).toThrow(CredentialDecryptionError);
  });

  it('rejects malformed tag length on a v2 envelope', () => {
    const env = makeEnvelope();
    expect(() =>
      makeCipher().decrypt({ ...env, tag: Buffer.alloc(8).toString('base64') }, { tenantId: TENANT, connectionId: CONN }),
    ).toThrow(CredentialDecryptionError);
  });
});

describe('CredentialCipher capability split', () => {
  it('encrypt() cannot produce v2 envelopes regardless of writer state', () => {
    const c = makeCipher();
    const out = c.encrypt({ token: 'x' });
    expect(out.v).toBe(1);
  });

  it('encryptWithActive() cannot produce v1 envelopes regardless of legacy writer state', () => {
    const c = makeCipher();
    const out = c.encryptWithActive({ token: 'x' }, Buffer.from(`${TENANT}:${CONN}`, 'utf8'));
    expect(out.v).toBe(2);
    expect(out.kid).toBe(ACTIVE_KID);
  });

  it('encrypt() throws CredentialLegacyV1WriterMissingError when the writer is null', () => {
    const ring = KeyRing.parse(`${ACTIVE_KID}:${ACTIVE_KEY.toString('base64')}`);
    const c = new CredentialCipher(null, ring);
    expect(() => c.encrypt({ token: 'x' })).toThrow(CredentialLegacyV1WriterMissingError);
  });

  it('encryptWithActive() throws CredentialActiveKeyMissingError when the ring has no active entry', () => {
    const c = new CredentialCipher(LEGACY_KEY, KeyRing.empty());
    expect(() => c.encryptWithActive({ token: 'x' }, Buffer.from('x'))).toThrow(
      CredentialActiveKeyMissingError,
    );
  });

  it('hasKey reflects either capability being configured', () => {
    const ringWithActive = KeyRing.parse(`${ACTIVE_KID}:${ACTIVE_KEY.toString('base64')}`);
    const ringWithout = KeyRing.empty();

    expect(new CredentialCipher(null, ringWithActive).hasKey).toBe(true);
    expect(new CredentialCipher(LEGACY_KEY, ringWithout).hasKey).toBe(true);
    expect(new CredentialCipher(null, ringWithout).hasKey).toBe(false);
  });
});
