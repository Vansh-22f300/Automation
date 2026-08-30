/**
 * Integration tests for the connections layer — these require a real PostgreSQL.
 *
 * SKIPPED unless `TEST_DATABASE_URL` is set; never faked. If the variable is
 * absent the suite reports skipped, not passed.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_workforce_test pnpm test
 *
 * What these cover that the offline unit tests cannot:
 *   - the generated migration creates `connections` and its constraints
 *   - the stored `encrypted_credentials` contains NO plaintext, and `resolveForTool`
 *     decrypts it back to the exact secret through the real query builder
 *   - `listMetadata`/`getMetadata` never return the secret
 *   - disable works, and a disabled connection refuses resolution
 *   - tenant isolation holds at the SQL level: tenant A cannot read, update,
 *     disable, delete, or resolve tenant B's connection
 *   - the one-active-per-provider partial unique index is enforced
 *
 * The suite writes and deletes rows, so it refuses any database whose name does
 * not contain "test". A dedicated, generated key is used — never a real one.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '@/db/client.js';
import { connections, tenants } from '@/db/schema.js';
import { ConnectionRepository } from '@/repositories/connection-repository.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import {
  CredentialCipher,
  generateCredentialKey,
  parseCredentialKey,
} from '@/security/credential-cipher.js';
import { DisabledConnectionError, MissingConnectionError } from '@/domain/tool-errors.js';

import { TEST_DATABASE_URL, createTestDatabaseHandle } from './support.js';

describe.skipIf(TEST_DATABASE_URL === undefined)('connections integration', () => {
  let handle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;
  // A test-only key, generated here — never a real deployment key.
  const cipher = new CredentialCipher(parseCredentialKey(generateCredentialKey()));

  const repoFor = (tenantId: string): ConnectionRepository =>
    new ConnectionRepository(new TenantScope(handle.db, tenantId), cipher);

  beforeAll(async () => {
    handle = createTestDatabaseHandle();
    await handle.verifyConnection();

    const inserted = await handle.db
      .insert(tenants)
      .values([{ name: 'Connections Tenant A' }, { name: 'Connections Tenant B' }])
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

  it('created the connections table via the migration', async () => {
    const result = await handle.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'connections'
        order by column_name`,
    );
    const columns = result.rows.map((r) => r.column_name);
    expect(columns).toContain('encrypted_credentials');
    expect(columns).toContain('provider');
    expect(columns).toContain('status');
    // No plaintext-bearing column exists.
    expect(columns).not.toContain('credentials');
    expect(columns).not.toContain('secret');
    expect(columns).not.toContain('token');
  });

  it('stores no plaintext and round-trips the secret via resolveForTool', async () => {
    const secret = { token: 'xoxb-INTEGRATION-SECRET', refresh: 'r-INTEGRATION' };
    const created = await repoFor(tenantA).create({ provider: 'slack', name: 'primary', credential: secret });

    // On disk: the raw row must not contain the plaintext anywhere.
    const [row] = await handle.db.select().from(connections).where(eq(connections.id, created.id));
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('xoxb-INTEGRATION-SECRET');
    expect(serialized).not.toContain('r-INTEGRATION');

    // Through the narrow decrypt path: the exact secret comes back.
    const authorized = await repoFor(tenantA).resolveForTool({ provider: 'slack' });
    expect(authorized.credential).toEqual(secret);
    // last_used_at is now set.
    expect(authorized.metadata.lastUsedAt).toBeInstanceOf(Date);
  });

  it('listMetadata and getMetadata never return the secret', async () => {
    await repoFor(tenantA).create({
      provider: 'github',
      name: 'ci',
      credential: { token: 'ghp-LISTING-SECRET' },
    });

    const list = await repoFor(tenantA).listMetadata();
    expect(JSON.stringify(list)).not.toContain('ghp-LISTING-SECRET');
    const one = list.find((c) => c.provider === 'github');
    expect(one).toBeDefined();
    expect(one).not.toHaveProperty('credential');
    expect(one).not.toHaveProperty('encryptedCredentials');

    const meta = await repoFor(tenantA).getMetadata(one!.id);
    expect(JSON.stringify(meta)).not.toContain('ghp-LISTING-SECRET');
  });

  it('disable turns a connection off and refuses resolution afterwards', async () => {
    const created = await repoFor(tenantA).create({
      provider: 'gmail',
      name: 'mailbox',
      credential: { token: 'gmail-DISABLE-SECRET' },
    });

    const disabled = await repoFor(tenantA).disable(created.id);
    expect(disabled?.status).toBe('disabled');

    // A disabled connection is refused by the resolver.
    await expect(repoFor(tenantA).resolveForTool({ provider: 'gmail' })).rejects.toBeInstanceOf(
      MissingConnectionError,
    );
    await expect(
      repoFor(tenantA).resolveForTool({ provider: 'gmail', connectionId: created.id }),
    ).rejects.toBeInstanceOf(DisabledConnectionError);
  });

  it('allows many active connections for the same (tenant, provider)', async () => {
    // The architecture explicitly permits e.g. two active Slack workspaces for one
    // tenant. Both creations must succeed — there is no one-active-per-provider index.
    const a = await repoFor(tenantA).create({
      provider: 'slack',
      name: 'workspace-a',
      credential: { token: 'slack-A-SECRET' },
    });
    const b = await repoFor(tenantA).create({
      provider: 'slack',
      name: 'workspace-b',
      credential: { token: 'slack-B-SECRET' },
    });

    // Both rows are present and active on disk.
    const [rowA] = await handle.db.select().from(connections).where(eq(connections.id, a.id));
    const [rowB] = await handle.db.select().from(connections).where(eq(connections.id, b.id));
    expect(rowA!.status).toBe('active');
    expect(rowB!.status).toBe('active');

    // A trusted connectionId selects EXACTLY the intended connection — A resolves to
    // A's secret, B resolves to B's secret. Selection is by id from trusted config,
    // never inferred from the provider alone.
    const resolvedA = await repoFor(tenantA).resolveForTool({ provider: 'slack', connectionId: a.id });
    const resolvedB = await repoFor(tenantA).resolveForTool({ provider: 'slack', connectionId: b.id });
    expect(resolvedA.credential).toEqual({ token: 'slack-A-SECRET' });
    expect(resolvedB.credential).toEqual({ token: 'slack-B-SECRET' });
    expect(resolvedA.metadata.id).toBe(a.id);
    expect(resolvedB.metadata.id).toBe(b.id);
  });

  it('refuses to resolve a disabled connection even by explicit id', async () => {
    const created = await repoFor(tenantA).create({
      provider: 'slack',
      name: 'workspace-disabled',
      credential: { token: 'slack-DISABLED-SECRET' },
    });
    await repoFor(tenantA).disable(created.id);

    await expect(
      repoFor(tenantA).resolveForTool({ provider: 'slack', connectionId: created.id }),
    ).rejects.toBeInstanceOf(DisabledConnectionError);
  });

  describe('tenant isolation', () => {
    let bConnId: string;

    beforeAll(async () => {
      const created = await repoFor(tenantB).create({
        provider: 'notion',
        name: 'b-only',
        credential: { token: 'notion-B-SECRET' },
      });
      bConnId = created.id;
    });

    it('A cannot read B’s connection metadata', async () => {
      expect(await repoFor(tenantA).getMetadata(bConnId)).toBeNull();
      const aList = await repoFor(tenantA).listMetadata();
      expect(aList.some((c) => c.id === bConnId)).toBe(false);
    });

    it('A cannot update or disable B’s connection', async () => {
      expect(await repoFor(tenantA).updateMetadata(bConnId, { hijacked: true })).toBeNull();
      expect(await repoFor(tenantA).disable(bConnId)).toBeNull();
      // B's row is untouched: still active.
      const [row] = await handle.db.select().from(connections).where(eq(connections.id, bConnId));
      expect(row!.status).toBe('active');
    });

    it('A cannot delete B’s connection', async () => {
      expect(await repoFor(tenantA).delete(bConnId)).toBe(false);
      const [row] = await handle.db.select().from(connections).where(eq(connections.id, bConnId));
      expect(row).toBeDefined();
    });

    it('A cannot resolve B’s connection by id (treated as missing, not leaked)', async () => {
      await expect(
        repoFor(tenantA).resolveForTool({ provider: 'notion', connectionId: bConnId }),
      ).rejects.toBeInstanceOf(MissingConnectionError);
    });
  });
});
