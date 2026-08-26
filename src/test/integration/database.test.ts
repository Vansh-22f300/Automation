/**
 * Integration tests — these require a real PostgreSQL server.
 *
 * They are SKIPPED unless `TEST_DATABASE_URL` is set. Nothing here is mocked or
 * simulated: if the variable is absent the suite reports skipped, never passed.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_workforce_test pnpm test
 *
 * What they cover, and why it cannot be covered offline:
 *   - the generated migration actually applies to PostgreSQL
 *   - the partial unique index really does permit many inactive versions and
 *     exactly one active one
 *   - the composite foreign key really does reject a cross-tenant version
 *   - `lower(email)` uniqueness really is case-insensitive
 *   - jsonb round-trips a nested definition unchanged
 *
 * The suite writes and deletes rows, so it refuses to run against a database
 * whose name does not contain "test".
 */

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnv } from '@/config/env.js';
import { createDatabase, describeDatabaseUrl } from '@/db/client.js';
import type { DatabaseHandle } from '@/db/client.js';
import { tenants, users, workflowVersions, workflows } from '@/db/schema.js';
import { createLogger } from '@/observability/logger.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** PostgreSQL SQLSTATE codes we assert on. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

function sqlStateOf(error: unknown): string | undefined {
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** A minimal definition document; the real Zod schema arrives in Step 6. */
const SAMPLE_DEFINITION = {
  steps: [
    { id: 'classify', type: 'llm', prompt: 'Classify this ticket' },
    { id: 'notify', type: 'action', connector: 'slack', operation: 'post_message' },
  ],
  entry: 'classify',
} as const;

describe.skipIf(TEST_DATABASE_URL === undefined)('database integration', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    const url = TEST_DATABASE_URL as string;
    const target = describeDatabaseUrl(url);

    if (!target.database.includes('test')) {
      throw new Error(
        `Refusing to run integration tests against database "${target.database}": ` +
          'these tests write and delete rows. Point TEST_DATABASE_URL at a database ' +
          'whose name contains "test".',
      );
    }

    const env = parseEnv({ DATABASE_URL: url, LOG_LEVEL: 'silent' });
    handle = createDatabase(env, createLogger(env, { service: 'test' }), {
      service: 'test',
      statementTimeoutMs: 60_000,
    });

    await handle.verifyConnection();
    await migrate(handle.db, { migrationsFolder: 'drizzle' });

    const inserted = await handle.db
      .insert(tenants)
      .values([{ name: 'Integration Tenant A' }, { name: 'Integration Tenant B' }])
      .returning({ id: tenants.id });

    tenantId = inserted[0]!.id;
    otherTenantId = inserted[1]!.id;
  });

  afterAll(async () => {
    if (handle === undefined) return;
    // Cascades remove users, workflows and versions.
    for (const id of [tenantId, otherTenantId]) {
      if (id !== undefined) await handle.db.delete(tenants).where(eq(tenants.id, id));
    }
    await handle.close();
  });

  it('applied the migration and created every table', async () => {
    const result = await handle.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`,
    );

    expect(result.rows.map((r) => r.table_name)).toEqual([
      'tenants',
      'users',
      'workflow_versions',
      'workflows',
    ]);
  });

  it('applies database-side defaults on insert', async () => {
    const [tenant] = await handle.db
      .insert(tenants)
      .values({ name: 'Defaults Check' })
      .returning();

    expect(tenant?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(tenant?.status).toBe('active');
    expect(tenant?.createdAt).toBeInstanceOf(Date);
    expect(tenant?.updatedAt).toBeInstanceOf(Date);

    await handle.db.delete(tenants).where(eq(tenants.id, tenant!.id));
  });

  it('treats email uniqueness as case-insensitive within a tenant', async () => {
    await handle.db.insert(users).values({ tenantId, email: 'casing@example.com' });

    const error = await handle.db
      .insert(users)
      .values({ tenantId, email: 'Casing@Example.com' })
      .then(() => undefined, (caught: unknown) => caught);

    expect(sqlStateOf(error)).toBe(UNIQUE_VIOLATION);
  });

  it('allows the same email in a different tenant', async () => {
    await expect(
      handle.db.insert(users).values({ tenantId: otherTenantId, email: 'casing@example.com' }),
    ).resolves.toBeDefined();
  });

  it('round-trips a nested definition through jsonb unchanged', async () => {
    const [workflow] = await handle.db
      .insert(workflows)
      .values({ tenantId, name: 'Triage' })
      .returning();

    const [version] = await handle.db
      .insert(workflowVersions)
      .values({
        tenantId,
        workflowId: workflow!.id,
        version: 1,
        definition: SAMPLE_DEFINITION,
        triggerType: 'webhook',
      })
      .returning();

    expect(version?.definition).toEqual(SAMPLE_DEFINITION);
    // Not supplied, so the column default has to have produced it.
    expect(version?.triggerConfig).toEqual({});
  });

  it('rejects a duplicate version number for the same workflow', async () => {
    const [workflow] = await handle.db
      .insert(workflows)
      .values({ tenantId, name: 'Duplicate Versions' })
      .returning();

    const values = {
      tenantId,
      workflowId: workflow!.id,
      version: 1,
      definition: SAMPLE_DEFINITION,
      triggerType: 'webhook',
    } as const;

    await handle.db.insert(workflowVersions).values(values);

    const error = await handle.db
      .insert(workflowVersions)
      .values(values)
      .then(() => undefined, (caught: unknown) => caught);

    expect(sqlStateOf(error)).toBe(UNIQUE_VIOLATION);
  });

  it('permits many inactive versions but only one active version', async () => {
    const [workflow] = await handle.db
      .insert(workflows)
      .values({ tenantId, name: 'Activation' })
      .returning();

    const version = (n: number, isActive: boolean) => ({
      tenantId,
      workflowId: workflow!.id,
      version: n,
      definition: SAMPLE_DEFINITION,
      triggerType: 'webhook' as const,
      isActive,
    });

    // Three inactive versions coexist: the index is partial, not total.
    await handle.db
      .insert(workflowVersions)
      .values([version(1, false), version(2, false), version(3, true)]);

    const error = await handle.db
      .insert(workflowVersions)
      .values(version(4, true))
      .then(() => undefined, (caught: unknown) => caught);

    expect(sqlStateOf(error)).toBe(UNIQUE_VIOLATION);
  });

  it('promotes a new active version inside one transaction', async () => {
    const [workflow] = await handle.db
      .insert(workflows)
      .values({ tenantId, name: 'Promotion' })
      .returning();

    const rows = await handle.db
      .insert(workflowVersions)
      .values([
        {
          tenantId,
          workflowId: workflow!.id,
          version: 1,
          definition: SAMPLE_DEFINITION,
          triggerType: 'webhook',
          isActive: true,
        },
        {
          tenantId,
          workflowId: workflow!.id,
          version: 2,
          definition: SAMPLE_DEFINITION,
          triggerType: 'webhook',
          isActive: false,
        },
      ])
      .returning({ id: workflowVersions.id, version: workflowVersions.version });

    const next = rows.find((r) => r.version === 2)!;

    await handle.db.transaction(async (tx) => {
      await tx
        .update(workflowVersions)
        .set({ isActive: false })
        .where(eq(workflowVersions.workflowId, workflow!.id));
      await tx
        .update(workflowVersions)
        .set({ isActive: true })
        .where(eq(workflowVersions.id, next.id));
    });

    const active = await handle.db
      .select({ version: workflowVersions.version })
      .from(workflowVersions)
      .where(
        and(eq(workflowVersions.workflowId, workflow!.id), eq(workflowVersions.isActive, true)),
      );

    expect(active).toEqual([{ version: 2 }]);
  });

  it('refuses a version whose tenant does not match its workflow', async () => {
    const [workflow] = await handle.db
      .insert(workflows)
      .values({ tenantId, name: 'Cross Tenant' })
      .returning();

    const error = await handle.db
      .insert(workflowVersions)
      .values({
        // Belongs to tenant B, but the workflow belongs to tenant A.
        tenantId: otherTenantId,
        workflowId: workflow!.id,
        version: 1,
        definition: SAMPLE_DEFINITION,
        triggerType: 'webhook',
      })
      .then(() => undefined, (caught: unknown) => caught);

    expect(sqlStateOf(error)).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('cascades deletes from tenant to workflow to version', async () => {
    const [tenant] = await handle.db
      .insert(tenants)
      .values({ name: 'Cascade Check' })
      .returning();

    const [workflow] = await handle.db
      .insert(workflows)
      .values({ tenantId: tenant!.id, name: 'Doomed' })
      .returning();

    await handle.db.insert(workflowVersions).values({
      tenantId: tenant!.id,
      workflowId: workflow!.id,
      version: 1,
      definition: SAMPLE_DEFINITION,
      triggerType: 'webhook',
    });

    await handle.db.delete(tenants).where(eq(tenants.id, tenant!.id));

    const remaining = await handle.db
      .select({ id: workflowVersions.id })
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, workflow!.id));

    expect(remaining).toEqual([]);
  });

  it('bumps updated_at on update but leaves created_at alone', async () => {
    const [tenant] = await handle.db
      .insert(tenants)
      .values({ name: 'Timestamps' })
      .returning();

    const [updated] = await handle.db
      .update(tenants)
      .set({ name: 'Timestamps Renamed' })
      .where(eq(tenants.id, tenant!.id))
      .returning();

    expect(updated!.createdAt.getTime()).toBe(tenant!.createdAt.getTime());
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(tenant!.updatedAt.getTime());

    await handle.db.delete(tenants).where(eq(tenants.id, tenant!.id));
  });
});
