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

import { isValidId, mapSummaryToVerdict, runCli, runVerifyDecrypt } from '@/cli/verify-connection-decrypt.js';
import type { VerifyCliDeps } from '@/cli/verify-connection-decrypt.js';
import { EnvValidationError } from '@/config/env.js';
import type { Env } from '@/config/env.js';
import type { DatabaseHandle } from '@/db/client.js';
import { RetryableError } from '@/domain/errors.js';
import type { Logger } from '@/observability/logger.js';
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

// ─── runCli: initialization + cleanup safety ──────────────────────────────────
// runCli enforces the UUID gate itself, so these use real UUIDs (unlike the direct
// runVerifyDecrypt tests above, which bypass it). The fakes make a chosen init stage
// fail; the assertions prove no raw detail (keyring, DB host, error message) reaches
// stdout/stderr, the exit code is nonzero, and a constructed pool is always closed.

const UUID_A = '018f3a3c-1b2c-7d3e-8f90-abcdef012345';
const UUID_B = '018f3a3c-1b2c-7d3e-8f90-abcdef999999';

/** A logger stub recording its `.error` calls — the only method runCli uses. */
function spyLogger(): { logger: Logger; calls: readonly unknown[][] } {
  const calls: unknown[][] = [];
  const logger = { error: (...args: unknown[]) => { calls.push(args); } } as unknown as Logger;
  return { logger, calls };
}

/** A database handle with scripted verify/close behavior; counts close() calls. */
function fakeHandle(opts: {
  verify?: () => Promise<void>;
  close?: () => Promise<void>;
}): { handle: DatabaseHandle; closeCalls: () => number } {
  let closeCount = 0;
  const handle = {
    db: {},
    pool: {},
    verifyConnection: opts.verify ?? (async () => {}),
    ping: async () => {},
    close: async () => {
      closeCount += 1;
      if (opts.close) await opts.close();
    },
  } as unknown as DatabaseHandle;
  return { handle, closeCalls: () => closeCount };
}

describe('runCli (initialization + cleanup safety)', () => {
  it('rejects non-UUID args without constructing env, cipher, or database', async () => {
    let loadCalls = 0;
    let cipherCalls = 0;
    let dbCalls = 0;
    const deps: VerifyCliDeps = {
      loadEnv: () => { loadCalls += 1; return {} as Env; },
      createLogger: () => spyLogger().logger,
      createCipher: () => { cipherCalls += 1; return cipherWithActive(); },
      createDatabase: () => { dbCalls += 1; return fakeHandle({}).handle; },
    };
    const out = captureSink();
    const err = captureSink();
    const code = await runCli({ argv: ['not-a-uuid', 'nope'], stdout: out.stream, stderr: err.stream }, deps);
    expect(code).toBe(1);
    expect(err.text()).toContain('usage:');
    expect(loadCalls).toBe(0);
    expect(cipherCalls).toBe(0);
    expect(dbCalls).toBe(0);
  });

  it('returns a sanitized FAIL when env validation fails (as the real parseEnv does) — no message leaks, no pool, no log', async () => {
    // The real default wires parseEnv, which throws EnvValidationError on a bad config.
    // Its message lists variable names + shape messages; a value must never leak even if a
    // message carried one, and the logger is not built yet, so nothing is logged at all.
    const SECRET = 'SECRET-value-smuggled-into-a-message';
    const envError = new EnvValidationError([
      { variable: 'CREDENTIAL_ENCRYPTION_KEYS', message: `invalid: ${SECRET}` },
    ]);
    let dbCalls = 0;
    const { logger, calls } = spyLogger();
    const deps: VerifyCliDeps = {
      loadEnv: () => { throw envError; },
      createLogger: () => logger,
      createCipher: () => cipherWithActive(),
      createDatabase: () => { dbCalls += 1; return fakeHandle({}).handle; },
    };
    const out = captureSink();
    const err = captureSink();
    const code = await runCli({ argv: [UUID_A, UUID_B], stdout: out.stream, stderr: err.stream }, deps);
    expect(code).toBe(1);
    expect(out.text()).toContain('RESULT: FAIL');
    expect(out.text() + err.text()).not.toContain(SECRET);
    expect(dbCalls).toBe(0); // never reached database construction
    expect(calls.length).toBe(0); // logger is built after env load, so nothing is logged
  });

  it('returns a sanitized FAIL when cipher construction throws — no keyring detail leaks, no pool opened', async () => {
    const SECRET = 'base64-KEYRING-secret-bytes';
    let dbCalls = 0;
    const { logger, calls } = spyLogger();
    const deps: VerifyCliDeps = {
      loadEnv: () => ({} as Env),
      createLogger: () => logger,
      createCipher: () => { throw new Error(SECRET); },
      createDatabase: () => { dbCalls += 1; return fakeHandle({}).handle; },
    };
    const out = captureSink();
    const err = captureSink();
    const code = await runCli({ argv: [UUID_A, UUID_B], stdout: out.stream, stderr: err.stream }, deps);
    expect(code).toBe(1);
    expect(out.text()).toContain('RESULT: FAIL');
    expect(out.text() + err.text()).not.toContain(SECRET);
    expect(dbCalls).toBe(0); // cipher is built before the pool
    // The logger existed, so exactly one typed, non-secret line is logged.
    expect(calls.length).toBe(1);
    expect(JSON.stringify(calls)).toContain('verify_connection_decrypt_error');
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  });

  it('closes the pool and emits a sanitized FAIL when verifyConnection fails — no DB host leaks', async () => {
    const SECRET_HOST = 'secret-neon-host.example';
    const unreachable = new RetryableError(
      'database_unreachable',
      `Cannot connect to PostgreSQL at ${SECRET_HOST}:5432/secretdb`,
      { details: { host: SECRET_HOST } },
    );
    const { handle, closeCalls } = fakeHandle({ verify: async () => { throw unreachable; } });
    const { logger, calls } = spyLogger();
    const deps: VerifyCliDeps = {
      loadEnv: () => ({} as Env),
      createLogger: () => logger,
      createCipher: () => cipherWithActive(),
      createDatabase: () => handle,
    };
    const out = captureSink();
    const err = captureSink();
    const code = await runCli({ argv: [UUID_A, UUID_B], stdout: out.stream, stderr: err.stream }, deps);
    expect(code).toBe(1);
    expect(out.text()).toContain('RESULT: FAIL');
    expect(out.text() + err.text()).not.toContain(SECRET_HOST);
    expect(closeCalls()).toBe(1); // cleanup ran even though the body failed
    // Only the typed code is logged, never the host-bearing message.
    expect(JSON.stringify(calls)).toContain('database_unreachable');
    expect(JSON.stringify(calls)).not.toContain(SECRET_HOST);
  });

  it('returns a sanitized FAIL when database construction throws — logs only a typed code, closes nothing', async () => {
    const SECRET = 'SECRET-pool-config-detail';
    const { logger, calls } = spyLogger();
    const deps: VerifyCliDeps = {
      loadEnv: () => ({} as Env),
      createLogger: () => logger,
      createCipher: () => cipherWithActive(),
      createDatabase: () => { throw new Error(SECRET); },
    };
    const out = captureSink();
    const err = captureSink();
    const code = await runCli({ argv: [UUID_A, UUID_B], stdout: out.stream, stderr: err.stream }, deps);
    expect(code).toBe(1);
    expect(out.text()).toContain('RESULT: FAIL');
    expect(out.text() + err.text()).not.toContain(SECRET);
    expect(calls.length).toBe(1); // logger existed → exactly one typed line
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  });

  it('returns a sanitized FAIL and closes the pool when the verify fails after connecting', async () => {
    // verifyConnection succeeds, so the body reaches runVerifyDecrypt → runRotate →
    // repository.listRotatable, which throws on the fake db (the realistic "DB drops
    // mid-run" case). The failure must stay sanitized and the pool must still close.
    const { handle, closeCalls } = fakeHandle({ verify: async () => {} });
    const { logger } = spyLogger();
    const deps: VerifyCliDeps = {
      loadEnv: () => ({} as Env),
      createLogger: () => logger,
      createCipher: () => cipherWithActive(),
      createDatabase: () => handle,
    };
    const out = captureSink();
    const err = captureSink();
    const code = await runCli({ argv: [UUID_A, UUID_B], stdout: out.stream, stderr: err.stream }, deps);
    expect(code).toBe(1);
    expect(closeCalls()).toBe(1); // cleanup ran after a post-connect failure
    expect(out.text()).toContain('RESULT: FAIL');
    expect(err.text()).toBe(''); // no stack trace / raw error on stderr
  });

  it('swallows a cleanup failure: a throwing close() changes neither the exit code nor the output', async () => {
    const SECRET_HOST = 'secret-neon-host.example';
    const { handle, closeCalls } = fakeHandle({
      verify: async () => { throw new RetryableError('database_unreachable', `at ${SECRET_HOST}`, {}); },
      close: async () => { throw new Error(`close failed talking to ${SECRET_HOST}`); },
    });
    const { logger } = spyLogger();
    const deps: VerifyCliDeps = {
      loadEnv: () => ({} as Env),
      createLogger: () => logger,
      createCipher: () => cipherWithActive(),
      createDatabase: () => handle,
    };
    const out = captureSink();
    const err = captureSink();
    const code = await runCli({ argv: [UUID_A, UUID_B], stdout: out.stream, stderr: err.stream }, deps);
    expect(code).toBe(1);
    expect(closeCalls()).toBe(1);
    expect(out.text()).toContain('RESULT: FAIL');
    expect(out.text() + err.text()).not.toContain(SECRET_HOST);
  });
});

