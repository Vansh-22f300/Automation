/**
 * Unit tests for the `pnpm connections rotate` CLI logic.
 *
 * The dispatcher in `src/cli/connections.ts` is a thin shell; the iteration
 * logic lives in `src/cli/connections-rotate.ts` and is exercised here
 * against a hand-rolled fake repository. The fake records every method call
 * so the tests can assert:
 *
 *   - dry-run enumerates via `listRotatable` and does NOT call
 *     `rotateCredentials`;
 *   - dry-run does NOT issue any locked SELECT (the repository's
 *     `listRotatable` is the only path it uses);
 *   - dry-run per-row output is `would-rotate` or `would-fail <reason>`
 *     with typed reasons for every documented failure mode;
 *   - dry-run summary matches the matrix and exit code matches the summary;
 *   - a real run calls `rotateCredentials` per row, prints the summary,
 *     and exits with the right code.
 *
 * The cryptographic contract (AAD binding, key resolution, malformed envelope
 * shapes) is exercised by `credential-cipher-v2.test.ts`. This file focuses on
 * the dispatch + I/O contract of the CLI command itself.
 */

import { Writable } from 'node:stream';

import { beforeEach, describe, expect, it } from 'vitest';

import { exitCodeFor, reasonForDecryptFailure, runRotate } from '@/cli/connections-rotate.js';
import type { RunRotateSummary } from '@/cli/connections-rotate.js';
import type {
  ConnectionRepository,
  RotatableConnection,
  RotatableListPage,
} from '@/repositories/connection-repository.js';
import type { ConnectionMetadata } from '@/domain/connection.js';
import type { EncryptedEnvelope } from '@/security/credential-cipher.js';
import {
  CredentialCipher,
  CredentialDecryptionError,
  generateCredentialKey,
  parseCredentialKey,
} from '@/security/credential-cipher.js';
import { KeyRing } from '@/security/keyring.js';

const ACTIVE_KID = 'kid-active';
const TENANT = 'tenant-1';

const ACTIVE_KEY = parseCredentialKey(generateCredentialKey());
const LEGACY_KEY = parseCredentialKey(generateCredentialKey());

function makeCipher(): CredentialCipher {
  const ring = KeyRing.parse(
    `${ACTIVE_KID}:${ACTIVE_KEY.toString('base64')},legacy-v1:${LEGACY_KEY.toString('base64')}`,
  );
  return new CredentialCipher(LEGACY_KEY, ring);
}

function makeRotatableRow(
  cipher: CredentialCipher,
  id: string,
  provider = 'slack',
  name = 'bot',
  useActive = false,
  envelope?: EncryptedEnvelope,
): RotatableConnection {
  let env: EncryptedEnvelope;
  if (envelope !== undefined) {
    env = envelope;
  } else if (useActive) {
    env = cipher.encryptWithActive(
      { token: `${id}-plain` },
      Buffer.from(`${TENANT}:${id}`, 'utf8'),
    );
  } else {
    env = cipher.encrypt({ token: `${id}-plain` });
  }
  return {
    id,
    provider,
    name,
    status: 'active',
    metadata: {},
    encryptedCredentials: env,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    lastUsedAt: null,
  };
}

class FakeRepository implements Pick<ConnectionRepository, 'listRotatable' | 'rotateCredentials'> {
  readonly listCalls: Array<{ activeKid: string; cursor: string | undefined }> = [];
  readonly rotateCalls: Array<{ id: string; activeKid: string }> = [];
  /** Pages to return, indexed by call number. */
  readonly pages: RotatableListPage[];
  /** Per-id result for rotateCredentials; `null` => skipped, `undefined` => default success. */
  rotateResults: Map<string, ConnectionMetadata | null> = new Map();
  /** Per-id override: if set, `rotateCredentials` throws the named error. */
  rotateThrows: Map<string, Error> = new Map();
  /** Default rotateCredentials result. */
  defaultRotateResult: ConnectionMetadata | null;

  constructor(pages: RotatableListPage[], defaultRotateResult: ConnectionMetadata | null = null) {
    this.pages = pages;
    this.defaultRotateResult = defaultRotateResult;
  }

  async listRotatable(
    activeKid: string,
    options: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<RotatableListPage> {
    this.listCalls.push({ activeKid, cursor: options.cursor });
    const idx = this.listCalls.length - 1;
    const page = this.pages[Math.min(idx, this.pages.length - 1)];
    return page ?? { items: [], nextCursor: null };
  }

  async rotateCredentials(id: string, activeKid: string): Promise<ConnectionMetadata | null> {
    this.rotateCalls.push({ id, activeKid });
    const err = this.rotateThrows.get(id);
    if (err !== undefined) throw err;
    if (this.rotateResults.has(id)) {
      const v = this.rotateResults.get(id);
      return v === undefined ? null : v;
    }
    return this.defaultRotateResult;
  }
}

function makeSummaryBuffer(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

function fakeMetadata(id: string, provider = 'slack', name = 'bot'): ConnectionMetadata {
  return {
    id,
    provider,
    name,
    status: 'active',
    metadata: {},
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-02T00:00:00Z'),
    lastUsedAt: null,
  };
}

describe('connections-rotate: dry-run', () => {
  let cipher: CredentialCipher;
  beforeEach(() => {
    cipher = makeCipher();
  });

  it('enumerates via listRotatable and never calls rotateCredentials', async () => {
    const rows = [makeRotatableRow(cipher, 'c1'), makeRotatableRow(cipher, 'c2')];
    const repo = new FakeRepository([{ items: rows, nextCursor: null }]);
    const buf = makeSummaryBuffer();

    const summary = await runRotate({
      repository: repo as unknown as ConnectionRepository,
      cipher,
      tenantId: TENANT,
      activeKid: ACTIVE_KID,
      connectionId: null,
      dryRun: true,
      batchSize: 100,
      stdout: buf.stream,
    });

    expect(repo.rotateCalls).toEqual([]);
    expect(repo.listCalls).toEqual([{ activeKid: ACTIVE_KID, cursor: undefined }]);
    expect(summary.dryRun).toBe(true);
    expect(summary.wouldRotate).toBe(2);
    expect(summary.wouldFail).toBe(0);
    expect(exitCodeFor(summary)).toBe(0);
  });

  it('prints would-rotate lines with old_kid from v1 envelopes ("legacy-v1") and the new active kid', async () => {
    const rows = [makeRotatableRow(cipher, 'c1', 'slack', 'bot-1', false)];
    const repo = new FakeRepository([{ items: rows, nextCursor: null }]);
    const buf = makeSummaryBuffer();

    const summary = await runRotate({
      repository: repo as unknown as ConnectionRepository,
      cipher,
      tenantId: TENANT,
      activeKid: ACTIVE_KID,
      connectionId: null,
      dryRun: true,
      batchSize: 100,
      stdout: buf.stream,
    });

    expect(summary.wouldRotate).toBe(1);
    expect(buf.text()).toContain(
      `[dry-run] would-rotate c1 slack/bot-1 legacy-v1 -> ${ACTIVE_KID}`,
    );
    expect(buf.text()).toContain('would-rotate: 1');
    expect(buf.text()).toContain('would-fail:    0');
  });

  it('classifies a decrypt failure as would-fail with reason "unknown_kid"', async () => {
    // Build a v2 envelope under a kid that is NOT in the main cipher's ring —
    // the main cipher's resolve(envelope.kid) throws, decrypt collapses to
    // `unknown_kid`. Use a fresh non-secret kid so the parser accepts it as
    // active (legacy-v1 cannot be the active entry).
    const orphanKid = 'kid-orphan';
    const orphanKey = parseCredentialKey(generateCredentialKey());
    const orphanRing = KeyRing.parse(`${orphanKid}:${orphanKey.toString('base64')}`);
    const orphanCipher = new CredentialCipher(LEGACY_KEY, orphanRing);
    const orphanEnv = orphanCipher.encryptWithActive(
      { token: 'x' },
      Buffer.from(`${TENANT}:c1`, 'utf8'),
    );
    const rows = [
      makeRotatableRow(cipher, 'c1', 'slack', 'bot-1', false, orphanEnv),
    ];
    const repo = new FakeRepository([{ items: rows, nextCursor: null }]);
    const buf = makeSummaryBuffer();

    const summary = await runRotate({
      repository: repo as unknown as ConnectionRepository,
      cipher,
      tenantId: TENANT,
      activeKid: ACTIVE_KID,
      connectionId: null,
      dryRun: true,
      batchSize: 100,
      stdout: buf.stream,
    });

    expect(summary.wouldRotate).toBe(0);
    expect(summary.wouldFail).toBe(1);
    expect(exitCodeFor(summary)).toBe(2);
    expect(buf.text()).toContain('[dry-run] would-fail    c1 slack/bot-1 unknown_kid');
  });

  it('exits 1 (partial) when would-rotate and would-fail both > 0', async () => {
    // Two rows: one clean (would-rotate), one with a corrupt ciphertext (would-fail).
    const good = makeRotatableRow(cipher, 'c1');
    const bad = makeRotatableRow(cipher, 'c2');
    const tamperedCt = Buffer.from(bad.encryptedCredentials.ct, 'base64');
    tamperedCt[0]! ^= 0xff;
    const tampered = {
      ...bad,
      encryptedCredentials: { ...bad.encryptedCredentials, ct: tamperedCt.toString('base64') },
    };
    const repo = new FakeRepository([{ items: [good, tampered], nextCursor: null }]);
    const buf = makeSummaryBuffer();

    const summary = await runRotate({
      repository: repo as unknown as ConnectionRepository,
      cipher,
      tenantId: TENANT,
      activeKid: ACTIVE_KID,
      connectionId: null,
      dryRun: true,
      batchSize: 100,
      stdout: buf.stream,
    });

    expect(summary.wouldRotate).toBe(1);
    expect(summary.wouldFail).toBe(1);
    expect(exitCodeFor(summary)).toBe(1);
    expect(buf.text()).toContain('[dry-run] would-rotate c1');
    expect(buf.text()).toContain('[dry-run] would-fail    c2');
  });

  it('classifies malformed envelope as would-fail with reason "malformed_envelope"', async () => {
    const row = makeRotatableRow(cipher, 'c1');
    const malformed = {
      ...row,
      encryptedCredentials: { ...row.encryptedCredentials, iv: Buffer.alloc(4).toString('base64') },
    };
    const repo = new FakeRepository([{ items: [malformed], nextCursor: null }]);
    const buf = makeSummaryBuffer();

    const summary = await runRotate({
      repository: repo as unknown as ConnectionRepository,
      cipher,
      tenantId: TENANT,
      activeKid: ACTIVE_KID,
      connectionId: null,
      dryRun: true,
      batchSize: 100,
      stdout: buf.stream,
    });

    expect(summary.wouldFail).toBe(1);
    expect(buf.text()).toContain('malformed_envelope');
  });

  it('dry-run with --connectionId finds the named row across pages', async () => {
    const page1 = { items: [makeRotatableRow(cipher, 'c1', 'slack', 'a')], nextCursor: 'cursor-1' };
    const page2 = { items: [makeRotatableRow(cipher, 'c2', 'slack', 'b')], nextCursor: null };
    const repo = new FakeRepository([page1, page2]);
    const buf = makeSummaryBuffer();

    const summary = await runRotate({
      repository: repo as unknown as ConnectionRepository,
      cipher,
      tenantId: TENANT,
      activeKid: ACTIVE_KID,
      connectionId: 'c2',
      dryRun: true,
      batchSize: 100,
      stdout: buf.stream,
    });

    expect(summary.wouldRotate).toBe(1);
    expect(repo.listCalls.length).toBe(2);
    expect(repo.listCalls[1]?.cursor).toBe('cursor-1');
    expect(buf.text()).toContain('[dry-run] would-rotate c2');
  });
});

describe('connections-rotate: real run', () => {
  let cipher: CredentialCipher;
  beforeEach(() => {
    cipher = makeCipher();
  });

  it('calls rotateCredentials per row and prints the summary', async () => {
    const rows = [makeRotatableRow(cipher, 'c1'), makeRotatableRow(cipher, 'c2')];
    const repo = new FakeRepository(
      [{ items: rows, nextCursor: null }],
      /* defaultRotateResult */ fakeMetadata('c1'),
    );
    repo.rotateResults.set('c2', fakeMetadata('c2', 'github', 'repo'));
    const buf = makeSummaryBuffer();

    const summary = await runRotate({
      repository: repo as unknown as ConnectionRepository,
      cipher,
      tenantId: TENANT,
      activeKid: ACTIVE_KID,
      connectionId: null,
      dryRun: false,
      batchSize: 100,
      stdout: buf.stream,
    });

    expect(repo.rotateCalls).toEqual([
      { id: 'c1', activeKid: ACTIVE_KID },
      { id: 'c2', activeKid: ACTIVE_KID },
    ]);
    expect(summary.rotated).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(exitCodeFor(summary)).toBe(0);
    expect(buf.text()).toContain('rotated: 2');
    expect(buf.text()).toContain('skipped: 0');
  });

  it('counts a null rotateCredentials result as "skipped" (already current)', async () => {
    const rows = [makeRotatableRow(cipher, 'c1')];
    const repo = new FakeRepository([{ items: rows, nextCursor: null }], null);
    const buf = makeSummaryBuffer();

    const summary = await runRotate({
      repository: repo as unknown as ConnectionRepository,
      cipher,
      tenantId: TENANT,
      activeKid: ACTIVE_KID,
      connectionId: null,
      dryRun: false,
      batchSize: 100,
      stdout: buf.stream,
    });

    expect(summary.skipped).toBe(1);
    expect(summary.rotated).toBe(0);
    expect(exitCodeFor(summary)).toBe(0);
    expect(buf.text()).toContain('skipped c1 slack/bot (already current)');
  });

  it('counts a rotateCredentials throw as "failed" with typed reason and exit 2 when alone', async () => {
    const rows = [makeRotatableRow(cipher, 'c1')];
    const repo = new FakeRepository([{ items: rows, nextCursor: null }], null);
    repo.rotateThrows.set('c1', new CredentialDecryptionError('failed to decrypt credential (bad key or tampered data)'));
    const buf = makeSummaryBuffer();

    const summary = await runRotate({
      repository: repo as unknown as ConnectionRepository,
      cipher,
      tenantId: TENANT,
      activeKid: ACTIVE_KID,
      connectionId: null,
      dryRun: false,
      batchSize: 100,
      stdout: buf.stream,
    });

    expect(summary.failed).toBe(1);
    expect(summary.rotated).toBe(0);
    expect(exitCodeFor(summary)).toBe(2);
    expect(buf.text()).toContain('failed  c1 slack/bot decrypt_failed');
  });

  it('emits a partial-success exit code 1 when rotated > 0 && failed > 0', async () => {
    const rows = [makeRotatableRow(cipher, 'c1'), makeRotatableRow(cipher, 'c2')];
    const repo = new FakeRepository(
      [{ items: rows, nextCursor: null }],
      fakeMetadata('c1'),
    );
    repo.rotateResults.set('c2', null);
    repo.rotateThrows.set('c2', new CredentialDecryptionError('failed to decrypt credential (bad key or tampered data)'));
    // c2 throws but rotateResults is also set — throws wins.
    const buf = makeSummaryBuffer();

    const summary = await runRotate({
      repository: repo as unknown as ConnectionRepository,
      cipher,
      tenantId: TENANT,
      activeKid: ACTIVE_KID,
      connectionId: null,
      dryRun: false,
      batchSize: 100,
      stdout: buf.stream,
    });

    expect(summary.rotated).toBe(1);
    expect(summary.failed).toBe(1);
    expect(exitCodeFor(summary)).toBe(1);
  });

  it('targets a single connectionId and does not iterate pages', async () => {
    const rows = [makeRotatableRow(cipher, 'c1')];
    const repo = new FakeRepository([{ items: rows, nextCursor: 'cursor-x' }]);
    repo.rotateResults.set('c1', fakeMetadata('c1'));
    const buf = makeSummaryBuffer();

    const summary = await runRotate({
      repository: repo as unknown as ConnectionRepository,
      cipher,
      tenantId: TENANT,
      activeKid: ACTIVE_KID,
      connectionId: 'c1',
      dryRun: false,
      batchSize: 100,
      stdout: buf.stream,
    });

    expect(summary.rotated).toBe(1);
    expect(repo.listCalls.length).toBe(0);
    expect(repo.rotateCalls).toEqual([{ id: 'c1', activeKid: ACTIVE_KID }]);
    expect(buf.text()).toContain('rotated c1');
  });
});

describe('connections-rotate: reason mapping', () => {
  it('maps each CredentialDecryptionError message to a stable typed reason', () => {
    const cases: Array<[string, string]> = [
      ['failed to decrypt credential (legacy_v1_key_missing)', 'legacy_v1_key_missing'],
      ['failed to decrypt credential (unknown_kid "x")', 'unknown_kid'],
      ['credential envelope has a malformed iv or tag', 'malformed_envelope'],
      ['unsupported credential envelope (version 7)', 'malformed_envelope'],
      ['unsupported credential envelope (algorithm rot13)', 'malformed_envelope'],
      ['credential envelope is missing a kid', 'malformed_envelope'],
      ['failed to decrypt credential (bad key or tampered data)', 'decrypt_failed'],
    ];
    for (const [message, expected] of cases) {
      expect(reasonForDecryptFailure(new CredentialDecryptionError(message))).toBe(expected);
    }
  });

  it('maps a non-cipher error to "db_error"', () => {
    expect(reasonForDecryptFailure(new Error('pg: connection refused'))).toBe('db_error');
    expect(reasonForDecryptFailure('plain string')).toBe('db_error');
    expect(reasonForDecryptFailure(undefined)).toBe('db_error');
  });
});

describe('connections-rotate: exit code matrix', () => {
  const cases: Array<{ s: RunRotateSummary; expected: number; describe: string }> = [
    { s: mk({ rotated: 0, skipped: 0, failed: 0, wouldRotate: 0, wouldFail: 0, dryRun: false }), expected: 0, describe: 'real: nothing to do' },
    { s: mk({ rotated: 5, skipped: 0, failed: 0, wouldRotate: 0, wouldFail: 0, dryRun: false }), expected: 0, describe: 'real: all rotated' },
    { s: mk({ rotated: 3, skipped: 2, failed: 1, wouldRotate: 0, wouldFail: 0, dryRun: false }), expected: 1, describe: 'real: partial' },
    { s: mk({ rotated: 0, skipped: 0, failed: 3, wouldRotate: 0, wouldFail: 0, dryRun: false }), expected: 2, describe: 'real: total failure' },
    { s: mk({ rotated: 0, skipped: 5, failed: 0, wouldRotate: 0, wouldFail: 0, dryRun: false }), expected: 0, describe: 'real: all skipped (already current)' },
    { s: mk({ rotated: 0, skipped: 0, failed: 0, wouldRotate: 0, wouldFail: 0, dryRun: true }), expected: 0, describe: 'dry: nothing to do' },
    { s: mk({ rotated: 0, skipped: 0, failed: 0, wouldRotate: 3, wouldFail: 0, dryRun: true }), expected: 0, describe: 'dry: all would-rotate' },
    { s: mk({ rotated: 0, skipped: 0, failed: 0, wouldRotate: 2, wouldFail: 1, dryRun: true }), expected: 1, describe: 'dry: partial' },
    { s: mk({ rotated: 0, skipped: 0, failed: 0, wouldRotate: 0, wouldFail: 3, dryRun: true }), expected: 2, describe: 'dry: total failure' },
  ];
  for (const { s, expected, describe: label } of cases) {
    it(`${label} → ${expected}`, () => {
      expect(exitCodeFor(s)).toBe(expected);
    });
  }
});

function mk(s: RunRotateSummary): RunRotateSummary {
  return s;
}
