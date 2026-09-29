/**
 * Unit tests for the ephemeral PKCE-verifier secret box (`@/oauth/state-secret-box`)
 * — state design §3. The verifier is a short secret that must be encrypted at rest
 * and bound to its own state row. These pin the AES-256-GCM seal/open roundtrip, the
 * envelope shape, and — crucially — that a wrong key, a wrong AAD, or any tampering
 * fails CLOSED with `OAuthStateSecretError` rather than yielding forged plaintext.
 * They also prove `createOAuthStateSecretBox` derives a deterministic HKDF subkey
 * from the credential cipher's key material (two boxes from one cipher interoperate).
 */

import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  type OAuthSecretEnvelope,
  OAuthStateSecretBox,
  OAuthStateSecretError,
  createOAuthStateSecretBox,
} from '@/oauth/state-secret-box.js';
import { CredentialCipher, generateCredentialKey, parseCredentialKey } from '@/security/credential-cipher.js';
import { KeyRing } from '@/security/keyring.js';

const caught = <T>(fn: () => unknown): T => {
  try {
    fn();
  } catch (error) {
    return error as T;
  }
  throw new Error('expected the function to throw, but it did not');
};

const PLAINTEXT = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'; // a PKCE-verifier-shaped secret
const AAD = 'the-state-hash-that-binds-this-row';
const OPEN_FAILURE = 'failed to open oauth-state secret (bad key, aad, or tampered data)';

describe('OAuthStateSecretBox', () => {
  const box = new OAuthStateSecretBox(randomBytes(32));

  it('seals and opens a roundtrip under the same AAD', () => {
    expect(box.open(box.seal(PLAINTEXT, AAD), AAD)).toBe(PLAINTEXT);
  });

  it('produces a well-formed envelope that never contains the plaintext', () => {
    const env = box.seal(PLAINTEXT, AAD);
    expect(env.v).toBe(1);
    expect(env.alg).toBe('aes-256-gcm');
    expect(Buffer.from(env.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(env.tag, 'base64')).toHaveLength(16);
    expect(env.ct).not.toContain(PLAINTEXT);
  });

  it('uses a fresh random IV per seal, so two seals of one secret differ', () => {
    const a = box.seal(PLAINTEXT, AAD);
    const b = box.seal(PLAINTEXT, AAD);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('fails closed on a wrong AAD', () => {
    const env = box.seal(PLAINTEXT, AAD);
    expect(() => box.open(env, 'a-different-aad')).toThrow(OAuthStateSecretError);
    expect(() => box.open(env, 'a-different-aad')).toThrow(OPEN_FAILURE);
  });

  it('fails closed on a wrong key', () => {
    const env = box.seal(PLAINTEXT, AAD);
    const other = new OAuthStateSecretBox(randomBytes(32));
    expect(() => other.open(env, AAD)).toThrow(OAuthStateSecretError);
  });

  it('fails closed on a tampered ciphertext', () => {
    const env = box.seal(PLAINTEXT, AAD);
    const ct = Buffer.from(env.ct, 'base64');
    ct[0] = ct[0]! ^ 0xff;
    expect(() => box.open({ ...env, ct: ct.toString('base64') }, AAD)).toThrow(OPEN_FAILURE);
  });

  it('fails closed on a tampered auth tag', () => {
    const env = box.seal(PLAINTEXT, AAD);
    const tag = Buffer.from(env.tag, 'base64');
    tag[0] = tag[0]! ^ 0xff;
    expect(() => box.open({ ...env, tag: tag.toString('base64') }, AAD)).toThrow(OPEN_FAILURE);
  });

  it('rejects an unsupported envelope version or algorithm before deciphering', () => {
    const env = box.seal(PLAINTEXT, AAD);
    expect(() => box.open({ ...env, v: 2 } as unknown as OAuthSecretEnvelope, AAD)).toThrow(
      'unsupported oauth-state secret envelope',
    );
    expect(() => box.open({ ...env, alg: 'aes-128-gcm' } as unknown as OAuthSecretEnvelope, AAD)).toThrow(
      'unsupported oauth-state secret envelope',
    );
  });

  it('rejects a malformed iv or tag length', () => {
    const env = box.seal(PLAINTEXT, AAD);
    const shortIv = { ...env, iv: Buffer.alloc(8).toString('base64') };
    const shortTag = { ...env, tag: Buffer.alloc(8).toString('base64') };
    expect(() => box.open(shortIv, AAD)).toThrow('oauth-state secret envelope has a malformed iv or tag');
    expect(() => box.open(shortTag, AAD)).toThrow('oauth-state secret envelope has a malformed iv or tag');
  });

  it('OAuthStateSecretError is a permanent, non-retryable failure', () => {
    const env = box.seal(PLAINTEXT, AAD);
    const error = caught<OAuthStateSecretError>(() => box.open(env, 'wrong-aad'));
    expect(error).toBeInstanceOf(OAuthStateSecretError);
    expect(error.code).toBe('oauth_state_secret_failed');
    expect(error.retryable).toBe(false);
  });
});

describe('createOAuthStateSecretBox', () => {
  // A test-only credential key — never a real deployment key. Legacy-only ring
  // (activeKid === null), so the box resolves the reserved legacy-v1 key material.
  const cipherKey = parseCredentialKey(generateCredentialKey());
  const cipher = new CredentialCipher(cipherKey, KeyRing.fromLegacyKey(cipherKey));

  it('derives a deterministic subkey: two boxes from one cipher interoperate', () => {
    const sealer = createOAuthStateSecretBox(cipher);
    const opener = createOAuthStateSecretBox(cipher);
    expect(opener.open(sealer.seal(PLAINTEXT, AAD), AAD)).toBe(PLAINTEXT);
  });

  it('a box from unrelated key material cannot open this cipher’s envelope', () => {
    const env = createOAuthStateSecretBox(cipher).seal(PLAINTEXT, AAD);
    const stranger = new OAuthStateSecretBox(randomBytes(32));
    expect(() => stranger.open(env, AAD)).toThrow(OAuthStateSecretError);
  });
});
