/**
 * Integration tests for the API-key layer — these require a real PostgreSQL.
 *
 * SKIPPED unless `TEST_DATABASE_URL` is set; never faked. If the variable is
 * absent the suite reports skipped, not passed.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_workforce_test pnpm test
 *
 * What these cover that the offline unit tests cannot:
 *   - the generated migration creates `api_keys` and its constraints
 *   - the plaintext secret is genuinely absent from every column on disk
 *   - tenant isolation holds at the SQL level: a repository pinned to tenant A
 *     cannot list or revoke tenant B's keys, through the real query builder
 *   - a real key round-trips through the real authenticator (prefix lookup +
 *     hash verify), and a revoked row is refused
 *
 * The suite writes and deletes rows, so it refuses any database whose name does
 * not contain "test".
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UnauthorizedError } from '@/api/errors.js';
import { ApiKeyAuthenticator } from '@/auth/api-key-authenticator.js';
import { DrizzleApiKeyStore } from '@/auth/api-key-store.js';
import type { DatabaseHandle } from '@/db/client.js';
import { apiKeys, tenants } from '@/db/schema.js';
import { ApiKeyRepository } from '@/repositories/api-key-repository.js';
import { TenantScope } from '@/repositories/tenant-scope.js';

import { TEST_DATABASE_URL, createTestDatabaseHandle } from './support.js';

describe.skipIf(TEST_DATABASE_URL === undefined)('api-key integration', () => {
  let handle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;

  const repoFor = (tenantId: string): ApiKeyRepository =>
    new ApiKeyRepository(new TenantScope(handle.db, tenantId));

  beforeAll(async () => {
    handle = createTestDatabaseHandle();
    await handle.verifyConnection();

    const inserted = await handle.db
      .insert(tenants)
      .values([{ name: 'API Key Tenant A' }, { name: 'API Key Tenant B' }])
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

  it('created the api_keys table via the migration', async () => {
    const result = await handle.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'api_keys'
        order by column_name`,
    );
    const columns = result.rows.map((r) => r.column_name);
    expect(columns).toContain('key_hash');
    expect(columns).toContain('prefix');
    // No plaintext-bearing column exists at all.
    expect(columns).not.toContain('key');
    expect(columns).not.toContain('secret');
    expect(columns).not.toContain('plaintext');
  });

  it('persists a hash and prefix, never the plaintext secret', async () => {
    const created = await repoFor(tenantA).create('persistence-check');
    const secret = created.plaintext.slice('awk_'.length);

    const [row] = await handle.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, created.id));

    expect(row).toBeDefined();
    expect(row!.keyHash).toMatch(/^[0-9a-f]{64}$/);
    // The secret appears in no stored column.
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain(created.plaintext);
  });

  it('resolves a real key to its tenant through the authenticator', async () => {
    const created = await repoFor(tenantA).create('auth-roundtrip');
    const authenticator = new ApiKeyAuthenticator(new DrizzleApiKeyStore(handle.db));

    const context = await authenticator.authenticate(created.plaintext);
    expect(context.tenantId).toBe(tenantA);
    expect(context.apiKeyId).toBe(created.id);
  });

  it('refuses a revoked key through the authenticator', async () => {
    const created = await repoFor(tenantA).create('revoke-roundtrip');
    await repoFor(tenantA).revoke(created.id);

    const authenticator = new ApiKeyAuthenticator(new DrizzleApiKeyStore(handle.db));
    await expect(authenticator.authenticate(created.plaintext)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('isolates tenants: A cannot list B’s keys', async () => {
    await repoFor(tenantB).create('b-only-key');

    const aKeys = await repoFor(tenantA).list();
    const bKeys = await repoFor(tenantB).list();

    expect(bKeys.some((k) => k.name === 'b-only-key')).toBe(true);
    expect(aKeys.some((k) => k.name === 'b-only-key')).toBe(false);
  });

  it('isolates tenants: A cannot revoke B’s key (404, not leaked)', async () => {
    const bKey = await repoFor(tenantB).create('b-revoke-target');

    await expect(repoFor(tenantA).revoke(bKey.id)).rejects.toMatchObject({
      statusCode: 404,
    });

    // B's key is untouched: still not revoked.
    const [row] = await handle.db
      .select({ revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, bKey.id));
    expect(row!.revokedAt).toBeNull();
  });
});
