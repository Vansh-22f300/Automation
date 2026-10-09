/**
 * Integration tests for GitHub-connection credential encryption at rest — the real
 * repository crypto paths an OAuth connection takes: callback upsert and refresh
 * compare-and-swap write-back. Proves these produce the v2 AES-256-GCM envelope
 * bound to the row's `${tenantId}:${connectionId}` AAD when an active key is
 * configured, never downgrade a v2 row to v1, and reject a ciphertext replayed
 * across tenants or connections.
 *
 * SKIPPED unless `TEST_DATABASE_URL` is set; never faked. The suite writes and
 * deletes rows, so `createTestDatabaseHandle` refuses any db whose name lacks "test".
 * Two freshly generated test keys are used — never a real deployment key.
 */

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { connections, tenants } from '@/db/schema.js';
import type { DatabaseHandle } from '@/db/client.js';
import { newId } from '@/domain/ids.js';
import { ConnectionRepository } from '@/repositories/connection-repository.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import {
  CredentialCipher,
  CredentialDecryptionError,
  generateCredentialKey,
  parseCredentialKey,
} from '@/security/credential-cipher.js';
import type { EncryptedEnvelope } from '@/security/credential-cipher.js';
import { KeyRing } from '@/security/keyring.js';

import { TEST_DATABASE_URL, createTestDatabaseHandle } from './support.js';

describe.skipIf(TEST_DATABASE_URL === undefined)('github connection encryption integration', () => {
  let handle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;

  const legacyKey = parseCredentialKey(generateCredentialKey());
  const activeKey = parseCredentialKey(generateCredentialKey());
  const activeKid = '2026-10-active';
  // v2 cipher: an active key is configured, so credential writes produce v2 + AAD.
  const cipher = new CredentialCipher(
    legacyKey,
    KeyRing.parse(`${activeKid}:${activeKey.toString('base64')},legacy-v1:${legacyKey.toString('base64')}`),
  );
  // legacy-only cipher: no active key, so writes can only be v1 (back-compat path).
  const legacyCipher = new CredentialCipher(legacyKey, KeyRing.fromLegacyKey(legacyKey));

  const repoFor = (tenantId: string): ConnectionRepository =>
    new ConnectionRepository(new TenantScope(handle.db, tenantId), cipher);
  const legacyRepoFor = (tenantId: string): ConnectionRepository =>
    new ConnectionRepository(new TenantScope(handle.db, tenantId), legacyCipher);

  const cred = (accessToken: string) => ({ accessToken, tokenType: 'bearer', refreshToken: `${accessToken}-rt`, scope: 'read:user' });
  const readEnvelope = async (id: string): Promise<EncryptedEnvelope> => {
    const [row] = await handle.db.select().from(connections).where(eq(connections.id, id));
    return row!.encryptedCredentials as EncryptedEnvelope;
  };

  beforeAll(async () => {
    handle = createTestDatabaseHandle();
    await handle.verifyConnection();
    const inserted = await handle.db
      .insert(tenants)
      .values([{ name: 'GH Enc Tenant A' }, { name: 'GH Enc Tenant B' }])
      .returning({ id: tenants.id });
    tenantA = inserted[0]!.id;
    tenantB = inserted[1]!.id;
  });

  afterEach(async () => {
    for (const id of [tenantA, tenantB]) {
      if (id !== undefined) await handle.db.delete(connections).where(eq(connections.tenantId, id));
    }
  });

  afterAll(async () => {
    if (handle === undefined) return;
    for (const id of [tenantA, tenantB]) {
      if (id !== undefined) await handle.db.delete(tenants).where(eq(tenants.id, id));
    }
    await handle.close();
  });

  it('upsertByProviderName stores a NEW connection as a v2 envelope bound to the row', async () => {
    const { id } = await repoFor(tenantA).upsertByProviderName({ provider: 'github', name: 'octocat', credential: cred('at-1') });
    const env = await readEnvelope(id);
    expect(env.v).toBe(2);
    expect((env as { kid: string }).kid).toBe(activeKid);
    const authorized = await repoFor(tenantA).resolveForTool({ provider: 'github', connectionId: id });
    expect(authorized.credential).toEqual(cred('at-1'));
  });

  it('re-authorization upserts in place: same id, still v2, credential replaced', async () => {
    const first = await repoFor(tenantA).upsertByProviderName({ provider: 'github', name: 'octocat', credential: cred('at-1') });
    const second = await repoFor(tenantA).upsertByProviderName({ provider: 'github', name: 'octocat', credential: cred('at-2') });
    expect(second.id).toBe(first.id); // healed one row, no duplicate
    const env = await readEnvelope(first.id);
    expect(env.v).toBe(2);
    const authorized = await repoFor(tenantA).resolveForTool({ provider: 'github', connectionId: first.id });
    expect(authorized.credential).toEqual(cred('at-2'));
  });

  it('compareAndSwapCredential keeps a v2 row v2 and persists the new tokens', async () => {
    const { id } = await repoFor(tenantA).upsertByProviderName({ provider: 'github', name: 'octocat', credential: cred('at-1') });
    const { encryptedCredentials } = await repoFor(tenantA).resolveWithEnvelope({ provider: 'github', connectionId: id });
    const outcome = await repoFor(tenantA).compareAndSwapCredential(id, encryptedCredentials.ct, cred('at-refreshed'));
    expect(outcome.status).toBe('applied');
    const env = await readEnvelope(id);
    expect(env.v).toBe(2);
    expect((env as { kid: string }).kid).toBe(activeKid);
    const authorized = await repoFor(tenantA).resolveForTool({ provider: 'github', connectionId: id });
    expect(authorized.credential).toEqual(cred('at-refreshed'));
  });

  it('compareAndSwapCredential UPGRADES a legacy v1 row to v2 on refresh', async () => {
    // Seed a v1 row (as a legacy connection would be stored) under the v2 cipher.
    const id = newId();
    const v1 = legacyCipher.encrypt(cred('at-v1'));
    await handle.db.insert(connections).values({ id, tenantId: tenantA, provider: 'github', name: 'octocat', encryptedCredentials: v1 });
    expect((await readEnvelope(id)).v).toBe(1);

    const { encryptedCredentials } = await repoFor(tenantA).resolveWithEnvelope({ provider: 'github', connectionId: id });
    const outcome = await repoFor(tenantA).compareAndSwapCredential(id, encryptedCredentials.ct, cred('at-upgraded'));
    expect(outcome.status).toBe('applied');
    const env = await readEnvelope(id);
    expect(env.v).toBe(2); // upgraded in place, never left v1
    expect((env as { kid: string }).kid).toBe(activeKid);
    expect((await repoFor(tenantA).resolveForTool({ provider: 'github', connectionId: id })).credential).toEqual(cred('at-upgraded'));
  });

  it('rejects decryption of a stored v2 envelope under the wrong tenant or connection AAD', async () => {
    const { id } = await repoFor(tenantA).upsertByProviderName({ provider: 'github', name: 'octocat', credential: cred('at-1') });
    const env = await readEnvelope(id);
    expect(cipher.decrypt(env, { tenantId: tenantA, connectionId: id })).toEqual(cred('at-1')); // correct AAD
    expect(() => cipher.decrypt(env, { tenantId: tenantB, connectionId: id })).toThrow(CredentialDecryptionError); // wrong tenant
    expect(() => cipher.decrypt(env, { tenantId: tenantA, connectionId: newId() })).toThrow(CredentialDecryptionError); // wrong connection
  });

  it('a CAS loser (stale ciphertext) does not overwrite the newer v2 credential', async () => {
    const { id } = await repoFor(tenantA).upsertByProviderName({ provider: 'github', name: 'octocat', credential: cred('at-1') });
    const stale = (await repoFor(tenantA).resolveWithEnvelope({ provider: 'github', connectionId: id })).encryptedCredentials.ct;
    const winner = await repoFor(tenantA).compareAndSwapCredential(id, stale, cred('winner'));
    expect(winner.status).toBe('applied');
    const loser = await repoFor(tenantA).compareAndSwapCredential(id, stale, cred('loser'));
    expect(loser.status).toBe('superseded');
    if (loser.status === 'superseded') expect(loser.credential).toEqual(cred('winner'));
    const env = await readEnvelope(id);
    expect(env.v).toBe(2);
    expect(cipher.decrypt(env, { tenantId: tenantA, connectionId: id })).toEqual(cred('winner')); // winner persisted, not loser
  });

  it('falls back to v1 when the deployment has no active key (legacy-only cipher)', async () => {
    const { id } = await legacyRepoFor(tenantA).upsertByProviderName({ provider: 'github', name: 'ghost', credential: cred('legacy') });
    const env = await readEnvelope(id);
    expect(env.v).toBe(1); // cannot produce v2 without an active key; not a downgrade
    expect((await legacyRepoFor(tenantA).resolveForTool({ provider: 'github', connectionId: id })).credential).toEqual(cred('legacy'));
  });

  it('leaves Slack `create` on v1 even when a v2 key is available (unchanged behavior)', async () => {
    const { id } = await repoFor(tenantA).create({ provider: 'slack', name: 'workspace', credential: { botToken: 'xoxb-test' } });
    const env = await readEnvelope(id);
    expect(env.v).toBe(1);
    expect((await repoFor(tenantA).resolveForTool({ provider: 'slack', connectionId: id })).credential).toEqual({ botToken: 'xoxb-test' });
  });
});
