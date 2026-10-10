/**
 * Unit tests for the manual credential-decryption verifier (`runVerifyDecrypt`).
 *
 * These prove the properties that make the manual workflow safe:
 *   - PASS only when the connection is actually FOUND and DECRYPTED (`wouldRotate`),
 *     never on a no-op (missing / wrong tenant / already current) — the key guard;
 *   - a found-but-undecryptable connection FAILs;
 *   - a missing active key FAILs without even touching the repository;
 *   - the only output is the sanitized RESULT line — the connection name, the
 *     plaintext credential and the encrypted envelope never leak.
 * All via a fake repository + a real cipher; no DB, no network.
 */

import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { isValidId, mapSummaryToVerdict, runVerifyDecrypt } from '@/cli/verify-connection-decrypt.js';
import type { ConnectionRepository, RotatableConnection, RotatableListPage } from '@/repositories/connection-repository.js';
import {
  CredentialCipher,
  generateCredentialKey,
  parseCredentialKey,
} from '@/security/credential-cipher.js';
import type { EncryptedEnvelope } from '@/security/credential-cipher.js';
import { KeyRing } from '@/security/keyring.js';

const TENANT = 'tenant-uuid';
const CONN = 'conn-1';
const SECRET_NAME = 'super-secret-bot-name';
const SECRET_TOKEN = 'PLAINTEXT-TOKEN-xyz';

const LEGACY_KEY = parseCredentialKey(generateCredentialKey());
const ACTIVE_KEY = parseCredentialKey(generateCredentialKey());

/** Cipher WITH an active key (v2 configured) — the normal rollout state. */
function cipherWithActive(): CredentialCipher {
  const ring = KeyRing.parse(`kid-active:${ACTIVE_KEY.toString('base64')},legacy-v1:${LEGACY_KEY.toString('base64')}`);
  return new CredentialCipher(LEGACY_KEY, ring);
}
/** Cipher with NO active key (legacy `CREDENTIAL_ENCRYPTION_KEY`-only). */
function cipherNoActive(): CredentialCipher {
  return new CredentialCipher(LEGACY_KEY, KeyRing.fromLegacyKey(LEGACY_KEY));
}

function v1Row(cipher: CredentialCipher, envelope?: EncryptedEnvelope): RotatableConnection {
  return {
    id: CONN,
    provider: 'slack',
    name: SECRET_NAME,
    status: 'active',
    metadata: {},
    encryptedCredentials: envelope ?? cipher.encrypt({ token: SECRET_TOKEN }),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastUsedAt: null,
  };
}

/** Minimal fake exposing only `listRotatable` (the dry-run's sole repository call). */
class FakeRepo {
  listCalls = 0;
  constructor(private readonly page: RotatableListPage) {}
  async listRotatable(): Promise<RotatableListPage> {
    this.listCalls += 1;
    return this.page;
  }
}

function captureSink(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(c.toString('utf8')); cb(); } });
  return { stream, text: () => chunks.join('') };
}

const page = (items: readonly RotatableConnection[]): RotatableListPage => ({ items, nextCursor: null });

describe('isValidId', () => {
  it('accepts a UUID and rejects anything else', () => {
    expect(isValidId('018f3a3c-1b2c-7d3e-8f90-abcdef012345')).toBe(true);
    expect(isValidId('not-a-uuid')).toBe(false);
    expect(isValidId('')).toBe(false);
    expect(isValidId(undefined)).toBe(false);
    expect(isValidId('018f3a3c-1b2c-7d3e-8f90-abcdef012345; drop table')).toBe(false);
  });
});

describe('mapSummaryToVerdict', () => {
  it('PASS only on found+decrypted; FAIL on decrypt failure and on a no-op', () => {
    expect(mapSummaryToVerdict({ wouldRotate: 1, wouldFail: 0 })).toMatchObject({ outcome: 'pass', reason: 'decrypted', exitCode: 0 });
    expect(mapSummaryToVerdict({ wouldRotate: 0, wouldFail: 1 })).toMatchObject({ outcome: 'fail', reason: 'decrypt_failed', exitCode: 1 });
    // The no-op (missing / wrong tenant / already current) must NOT be a pass.
    expect(mapSummaryToVerdict({ wouldRotate: 0, wouldFail: 0 })).toMatchObject({ outcome: 'fail', reason: 'not_found_or_already_current', exitCode: 1 });
  });
});

describe('runVerifyDecrypt', () => {
  it('PASSes when the connection is found and decrypts — leaking no name/credential/envelope', async () => {
    const cipher = cipherWithActive();
    const row = v1Row(cipher);
    const repo = new FakeRepo(page([row]));
    const out = captureSink();
    const verdict = await runVerifyDecrypt({
      repository: repo as unknown as ConnectionRepository,
      cipher,
      tenantId: TENANT,
      connectionId: CONN,
      stdout: out.stream,
    });
    expect(verdict).toMatchObject({ outcome: 'pass', reason: 'decrypted', exitCode: 0 });
    const text = out.text();
    expect(text).toContain('RESULT: PASS');
    expect(text).not.toContain(SECRET_NAME);
    expect(text).not.toContain(SECRET_TOKEN);
    expect(text).not.toContain((row.encryptedCredentials as { ct: string }).ct);
  });

  it('FAILs (decrypt_failed) when the connection is found but the credential will not decrypt', async () => {
    const cipher = cipherWithActive();
    const good = cipher.encrypt({ token: SECRET_TOKEN });
    const tampered: EncryptedEnvelope = { ...good, ct: Buffer.from('tampered-ciphertext').toString('base64') };
    const repo = new FakeRepo(page([v1Row(cipher, tampered)]));
    const out = captureSink();
    const verdict = await runVerifyDecrypt({
      repository: repo as unknown as ConnectionRepository,
      cipher,
      tenantId: TENANT,
      connectionId: CONN,
      stdout: out.stream,
    });
    expect(verdict).toMatchObject({ outcome: 'fail', reason: 'decrypt_failed', exitCode: 1 });
    expect(out.text()).toContain('RESULT: FAIL');
  });

  it('FAILs (not_found_or_already_current) on a no-op — connection not in the rotatable set', async () => {
    const cipher = cipherWithActive();
    const repo = new FakeRepo(page([])); // nothing found
    const out = captureSink();
    const verdict = await runVerifyDecrypt({
      repository: repo as unknown as ConnectionRepository,
      cipher,
      tenantId: TENANT,
      connectionId: CONN,
      stdout: out.stream,
    });
    expect(verdict).toMatchObject({ outcome: 'fail', reason: 'not_found_or_already_current', exitCode: 1 });
  });

  it('FAILs (no_active_key) and never queries the repository when no active key is configured', async () => {
    const cipher = cipherNoActive();
    const repo = new FakeRepo(page([v1Row(cipher)]));
    const out = captureSink();
    const verdict = await runVerifyDecrypt({
      repository: repo as unknown as ConnectionRepository,
      cipher,
      tenantId: TENANT,
      connectionId: CONN,
      stdout: out.stream,
    });
    expect(verdict).toMatchObject({ outcome: 'fail', reason: 'no_active_key', exitCode: 1 });
    expect(repo.listCalls).toBe(0);
  });
});

