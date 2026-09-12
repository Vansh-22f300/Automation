/**
 * Credential cipher unit tests — v1 envelope shape and capability split.
 *
 * These prove the properties that make the store trustworthy, not just that it
 * "runs": a true round-trip, non-deterministic ciphertext, and — the two that
 * matter most — that tampering and the wrong key are *detected* rather than
 * silently yielding forged plaintext. The v2 envelope shape, AAD binding, and
 * the `encryptWithActive` / `kid` resolution paths are covered by the sibling
 * file `credential-cipher-v2.test.ts`.
 *
 * The constructor takes `(legacyV1Writer, ring)`. For tests that only care
 * about the v1 read/write path, the same KEY is registered in both places: as
 * the legacy writer and as the ring's `legacy-v1` decrypt-only entry.
 */

import { describe, expect, it } from 'vitest';

import {
  CredentialCipher,
  CredentialDecryptionError,
  CredentialKeyInvalidError,
  CredentialLegacyV1WriterMissingError,
  generateCredentialKey,
  parseCredentialKey,
} from '@/security/credential-cipher.js';
import { KeyRing } from '@/security/keyring.js';

const KEY = parseCredentialKey(generateCredentialKey());
const cipher = () => new CredentialCipher(KEY, KeyRing.fromLegacyKey(KEY));

describe('CredentialCipher round-trip', () => {
  it('decrypt(encrypt(x)) deep-equals x', () => {
    const secret = { token: 'xoxb-123', refresh: 'r-456', scopes: ['a', 'b'], n: 7 };
    const envelope = cipher().encrypt(secret);
    expect(cipher().decrypt(envelope)).toEqual(secret);
  });

  it('produces a versioned, self-describing envelope (v: 1)', () => {
    const envelope = cipher().encrypt({ a: 1 });
    expect(envelope.v).toBe(1);
    expect(envelope.alg).toBe('aes-256-gcm');
    expect(typeof envelope.iv).toBe('string');
    expect(typeof envelope.ct).toBe('string');
    expect(typeof envelope.tag).toBe('string');
  });

  it('does not store the plaintext anywhere in the envelope', () => {
    const envelope = cipher().encrypt({ token: 'PLAINTEXT_SECRET' });
    expect(JSON.stringify(envelope)).not.toContain('PLAINTEXT_SECRET');
  });

  it('encrypts the same secret to different ciphertext each time (random IV)', () => {
    const c = cipher();
    const a = c.encrypt({ token: 'same' });
    const b = c.encrypt({ token: 'same' });
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    // …but both decrypt back to the same value.
    expect(c.decrypt(a)).toEqual(c.decrypt(b));
  });
});

describe('CredentialCipher tamper & key detection', () => {
  it('rejects a tampered ciphertext', () => {
    const envelope = cipher().encrypt({ token: 'x' });
    const ct = Buffer.from(envelope.ct, 'base64');
    ct[0]! ^= 0xff;
    const tampered = { ...envelope, ct: ct.toString('base64') };
    expect(() => cipher().decrypt(tampered)).toThrow(CredentialDecryptionError);
  });

  it('rejects a tampered auth tag', () => {
    const envelope = cipher().encrypt({ token: 'x' });
    const tag = Buffer.from(envelope.tag, 'base64');
    tag[0]! ^= 0xff;
    const tampered = { ...envelope, tag: tag.toString('base64') };
    expect(() => cipher().decrypt(tampered)).toThrow(CredentialDecryptionError);
  });

  it('fails to decrypt with the wrong key', () => {
    const envelope = cipher().encrypt({ token: 'x' });
    const otherKey = parseCredentialKey(generateCredentialKey());
    const other = new CredentialCipher(otherKey, KeyRing.fromLegacyKey(otherKey));
    expect(() => other.decrypt(envelope)).toThrow(CredentialDecryptionError);
  });

  it('rejects an unsupported envelope algorithm', () => {
    const envelope = cipher().encrypt({ token: 'x' });
    expect(() => cipher().decrypt({ ...envelope, alg: 'rot13' as 'aes-256-gcm' })).toThrow(
      CredentialDecryptionError,
    );
  });

  it('rejects a malformed iv/tag length', () => {
    const envelope = cipher().encrypt({ token: 'x' });
    expect(() => cipher().decrypt({ ...envelope, iv: Buffer.alloc(4).toString('base64') })).toThrow(
      CredentialDecryptionError,
    );
  });
});

describe('CredentialCipher missing key (v1 writer split)', () => {
  const keyless = new CredentialCipher(null, KeyRing.empty());

  it('reports no key when neither capability is configured', () => {
    expect(keyless.hasKey).toBe(false);
    expect(cipher().hasKey).toBe(true);
  });

  it('throws CredentialLegacyV1WriterMissingError on encrypt with no v1 writer', () => {
    expect(() => keyless.encrypt({ a: 1 })).toThrow(CredentialLegacyV1WriterMissingError);
  });

  it('throws CredentialDecryptionError("legacy_v1_key_missing") on decrypt of v1 envelope with no ring entry', () => {
    const envelope = cipher().encrypt({ a: 1 });
    expect(() => keyless.decrypt(envelope)).toThrow(CredentialDecryptionError);
  });
});

describe('parseCredentialKey', () => {
  it('accepts 64 hex characters', () => {
    const hex = 'a'.repeat(64);
    expect(parseCredentialKey(hex).length).toBe(32);
  });

  it('accepts base64 decoding to 32 bytes', () => {
    const b64 = generateCredentialKey();
    expect(parseCredentialKey(b64).length).toBe(32);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => parseCredentialKey('deadbeef')).toThrow(CredentialKeyInvalidError);
    expect(() => parseCredentialKey('a'.repeat(63))).toThrow(CredentialKeyInvalidError);
  });

  it('generateCredentialKey yields a parseable 32-byte key', () => {
    expect(parseCredentialKey(generateCredentialKey()).length).toBe(32);
  });
});
