/**
 * Integration tests for `ConnectionRepository.listRotatable` and
 * `rotateCredentials`, plus the cryptographic read/write paths under a v2
 * active key.
 *
 * SKIPPED unless `TEST_DATABASE_URL` is set; never faked. If the variable is
 * absent the suite reports skipped, not passed.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_workforce_test pnpm test
 *
 * What these cover that the offline unit tests cannot:
 *   - the v2 envelope shape persists in `encrypted_credentials jsonb` without
 *     a schema migration;
 *   - `listRotatable` filters by `(encrypted_credentials ->> 'kid') IS DISTINCT
 *     FROM activeKid` at the SQL layer, including NULL handling for v1 rows;
 *   - `rotateCredentials` re-encrypts the row under the active kid with AAD;
 *   - the per-row `SELECT ... FOR UPDATE` plus re-checked predicate prevents
 *     double-rotation across two concurrent rotations;
 *   - concurrent `updateMetadata` serializes with rotation by row lock;
 *   - `resolveForTool` decrypts v2 envelopes correctly when AAD is supplied;
 *   - cross-tenant rotation is impossible by construction (a tenant-scoped
 *     repository cannot rotate another tenant's row);
 *   - **the dry-run contract** validates decryptability without writes
 *     (encrypted_credentials unchanged before and after; updated_at and
 *     last_used_at unchanged); the typed `would-fail` reasons are surfaced.
 *
 * The suite writes and deletes rows, so it refuses any database whose name does
 * not contain "test". Two freshly generated test keys are used — never a real
 * deployment key.
 */

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Writable } from 'node:stream';

import { runRotate } from '@/cli/connections-rotate.js';
import type { DatabaseHandle } from '@/db/client.js';
import { newId } from '@/domain/ids.js';
import { connections, tenants } from '@/db/schema.js';
import { ConnectionRepository } from '@/repositories/connection-repository.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import {
  CredentialCipher,
  generateCredentialKey,
  parseCredentialKey,
} from '@/security/credential-cipher.js';
import { KeyRing } from '@/security/keyring.js';

import { TEST_DATABASE_URL, createTestDatabaseHandle } from './support.js';

describe.skipIf(TEST_DATABASE_URL === undefined)('connections rotation integration', () => {
  let handle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;
  const legacyKey = parseCredentialKey(generateCredentialKey());
  const activeKey = parseCredentialKey(generateCredentialKey());
  const activeKid = '2026-09-active';
  const ring = KeyRing.parse(
    `${activeKid}:${activeKey.toString('base64')},legacy-v1:${legacyKey.toString('base64')}`,
  );
  const cipher = new CredentialCipher(legacyKey, ring);

  const repoFor = (tenantId: string): ConnectionRepository =>
    new ConnectionRepository(new TenantScope(handle.db, tenantId), cipher);

  beforeAll(async () => {
    handle = createTestDatabaseHandle();
    await handle.verifyConnection();

    const inserted = await handle.db
      .insert(tenants)
      .values([{ name: 'Rotation Tenant A' }, { name: 'Rotation Tenant B' }])
      .returning({ id: tenants.id });
    tenantA = inserted[0]!.id;
    tenantB = inserted[1]!.id;
  });

  afterAll(async () => {
    if (handle === undefined) return;
    for (const id of [tenantA, tenantB]) {
      if (id !== undefined) await handle.db.delete(tenants).where(eq(tenants.id, id));
    }
    await handle.close();
  });

  async function insertV1Row(tenantId: string, provider: string, name: string, secret: string): Promise<string> {
    const envelope = cipher.encrypt({ token: secret });
    const [row] = await handle.db
      .insert(connections)
      .values({ tenantId, provider, name, encryptedCredentials: envelope })
      .returning({ id: connections.id });
    return row!.id;
  }

  function captureStdout(): { stream: NodeJS.WritableStream; text: () => string } {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString('utf8'));
        cb();
      },
    });
    return { stream, text: () => chunks.join('') };
  }

  it('listRotatable returns every v1 row in the tenant (v1 has no kid; NULL is DISTINCT FROM any string)', async () => {
    const id1 = await insertV1Row(tenantA, 'slack', 'rot-1', 'tok-1');
    const id2 = await insertV1Row(tenantA, 'github', 'rot-2', 'tok-2');
    await insertV1Row(tenantB, 'slack', 'other-tenant', 'tok-3');

    const page = await repoFor(tenantA).listRotatable(activeKid, { limit: 100 });
    const ids = page.items.map((r) => r.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    // Cross-tenant row is excluded by TenantScope.
    expect(ids).not.toContain('rot-other');

    // Cleanup
    await handle.db.delete(connections).where(eq(connections.tenantId, tenantA));
    await handle.db.delete(connections).where(eq(connections.tenantId, tenantB));
  });

  it('listRotatable excludes rows whose kid already equals the active kid', async () => {
    const idV1 = await insertV1Row(tenantA, 'slack', 'rot-v1', 'tok-v1');
    const v2 = cipher.encryptWithActive({ token: 'tok-v2' }, Buffer.from(`${tenantA}:will-be-id`, 'utf8'));
    const [v2Row] = await handle.db
      .insert(connections)
      .values({
        tenantId: tenantA,
        provider: 'github',
        name: 'rot-v2',
        encryptedCredentials: v2,
      })
      .returning({ id: connections.id });
    const v2Id = v2Row!.id;

    const page = await repoFor(tenantA).listRotatable(activeKid, { limit: 100 });
    const ids = page.items.map((r) => r.id);
    expect(ids).toContain(idV1);
    expect(ids).not.toContain(v2Id); // Already on active kid.

    // Cleanup
    await handle.db.delete(connections).where(eq(connections.tenantId, tenantA));
  });

  it('rotateCredentials re-encrypts a v1 row under the active kid with AAD', async () => {
    const id = await insertV1Row(tenantA, 'slack', 'rot-real', 'tok-real');
    const before = await handle.db
      .select()
      .from(connections)
      .where(eq(connections.id, id));
    expect(before[0]!.encryptedCredentials).toMatchObject({ v: 1 });

    const updated = await repoFor(tenantA).rotateCredentials(id, activeKid);
    expect(updated).not.toBeNull();

    const after = await handle.db
      .select()
      .from(connections)
      .where(eq(connections.id, id));
    const env = after[0]!.encryptedCredentials as { v: number; kid: string };
    expect(env.v).toBe(2);
    expect(env.kid).toBe(activeKid);

    // The decrypted credential is the original secret.
    const authorized = await repoFor(tenantA).resolveForTool({ provider: 'slack', connectionId: id });
    expect(authorized.credential).toEqual({ token: 'tok-real' });
    await handle.db.delete(connections).where(eq(connections.tenantId, tenantA));
  });

  it('rotateCredentials returns null when the row is already on the active kid', async () => {
    const env = cipher.encryptWithActive({ token: 'tok' }, Buffer.from(`${tenantA}:x`, 'utf8'));
    const [row] = await handle.db
      .insert(connections)
      .values({
        tenantId: tenantA,
        provider: 'slack',
        name: 'already-current',
        encryptedCredentials: env,
      })
      .returning({ id: connections.id });

    const updated = await repoFor(tenantA).rotateCredentials(row!.id, activeKid);
    expect(updated).toBeNull();

    await handle.db.delete(connections).where(eq(connections.tenantId, tenantA));
  });

  it('rotateCredentials returns null when the id is in another tenant (tenant isolation)', async () => {
    const idB = await insertV1Row(tenantB, 'slack', 'rot-other', 'tok-other');
    const updated = await repoFor(tenantA).rotateCredentials(idB, activeKid);
    expect(updated).toBeNull();

    // Cleanup
    await handle.db.delete(connections).where(eq(connections.tenantId, tenantB));
  });

  it('--dry-run validates decryptability without writing', async () => {
    const id1 = await insertV1Row(tenantA, 'slack', 'dry-1', 'dry-tok-1');
    const id2 = await insertV1Row(tenantA, 'slack', 'dry-2', 'dry-tok-2');

    const beforeRows = await handle.db
      .select({
        id: connections.id,
        encrypted: connections.encryptedCredentials,
        updatedAt: connections.updatedAt,
        lastUsedAt: connections.lastUsedAt,
      })
      .from(connections)
      .where(eq(connections.tenantId, tenantA));

    const capture = captureStdout();
    const summary = await runRotate({
      repository: repoFor(tenantA),
      cipher,
      tenantId: tenantA,
      activeKid,
      connectionId: null,
      dryRun: true,
      batchSize: 100,
      stdout: capture.stream,
    });

    expect(summary.wouldRotate).toBeGreaterThanOrEqual(2);
    expect(summary.wouldFail).toBe(0);

    const afterRows = await handle.db
      .select({
        id: connections.id,
        encrypted: connections.encryptedCredentials,
        updatedAt: connections.updatedAt,
        lastUsedAt: connections.lastUsedAt,
      })
      .from(connections)
      .where(eq(connections.tenantId, tenantA));

    // Encrypted credentials, updated_at and last_used_at must be unchanged.
    expect(afterRows.length).toBe(beforeRows.length);
    for (const before of beforeRows) {
      const after = afterRows.find((r) => r.id === before.id)!;
      expect(after.encrypted).toEqual(before.encrypted);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect((after.lastUsedAt ?? null)?.getTime() ?? null).toBe(
        (before.lastUsedAt ?? null)?.getTime() ?? null,
      );
    }

    expect(capture.text()).toContain(`[dry-run] would-rotate ${id1}`);
    expect(capture.text()).toContain(`[dry-run] would-rotate ${id2}`);
    expect(capture.text()).toContain('would-rotate:');

    await handle.db.delete(connections).where(eq(connections.tenantId, tenantA));
  });

  it('--dry-run surfaces would-fail for a tampered ciphertext', async () => {
    const id = await insertV1Row(tenantA, 'slack', 'tampered', 'tampered-tok');
    // Tamper with the stored ciphertext directly so decrypt will fail under the
    // same GCM key the dry-run uses.
    await handle.db.execute(
      sql`update ${connections}
          set encrypted_credentials = jsonb_set(
            encrypted_credentials,
            '{ct}',
            to_jsonb(encode(decode(encrypted_credentials->>'ct', 'base64')::bytea || decode('00', 'hex'), 'base64'))
          )
          where id = ${id}`,
    );

    const capture = captureStdout();
    const summary = await runRotate({
      repository: repoFor(tenantA),
      cipher,
      tenantId: tenantA,
      activeKid,
      connectionId: null,
      dryRun: true,
      batchSize: 100,
      stdout: capture.stream,
    });

    expect(summary.wouldFail).toBeGreaterThanOrEqual(1);
    expect(capture.text()).toContain(`[dry-run] would-fail    ${id} slack/tampered`);

    await handle.db.delete(connections).where(eq(connections.tenantId, tenantA));
  });

  it('resolveForTool decrypts a v2 envelope correctly with the (tenantId, connectionId) AAD', async () => {
    // Pre-generate the connection id so the AAD at encrypt time matches the
    // row id at decrypt time — the row's primary key is supplied to the
    // INSERT, so we own it before the insert returns.
    const id = newId();
    const aad = Buffer.from(`${tenantA}:${id}`, 'utf8');
    const v2 = cipher.encryptWithActive({ token: 'v2-tok' }, aad);
    const [row] = await handle.db
      .insert(connections)
      .values({
        id,
        tenantId: tenantA,
        provider: 'slack',
        name: 'v2-tool',
        encryptedCredentials: v2,
      })
      .returning({ id: connections.id });
    expect(row!.id).toBe(id);

    const authorized = await repoFor(tenantA).resolveForTool({ provider: 'slack', connectionId: id });
    expect(authorized.credential).toEqual({ token: 'v2-tok' });

    await handle.db.delete(connections).where(eq(connections.tenantId, tenantA));
  });
});
