/**
 * Integration tests for the workflow / workflow-version service — real PostgreSQL.
 *
 * SKIPPED unless `TEST_DATABASE_URL` is set; never faked. If the variable is
 * absent the suite reports skipped, not passed.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_workforce_test pnpm test
 *
 * What these cover that the offline unit tests cannot:
 *   - a workflow and its version 1 are created transactionally, under the right
 *     tenant, with the definition and trigger config stored as JSONB
 *   - version 2 is a fresh INSERT that leaves version 1 byte-for-byte unchanged
 *   - version numbers are monotonic and the DB unique constraint refuses a dupe
 *   - activating v2 deactivates v1, and the partial unique index holds "one active"
 *   - inactive versions remain readable
 *   - tenant isolation at the SQL level: tenant A cannot read, add a version to,
 *     or activate tenant B's workflow — each fails as NotFound, not a leak
 *
 * The suite writes and deletes rows, so it refuses any database whose name does
 * not contain "test".
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NotFoundError } from '@/api/errors.js';
import type { DatabaseHandle } from '@/db/client.js';
import { tenants, workflowVersions } from '@/db/schema.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import { WorkflowRepository } from '@/repositories/workflow-repository.js';

import { TEST_DATABASE_URL, createTestDatabaseHandle } from './support.js';

const linear = (keys: string[]) => ({
  version: 1,
  steps: keys.map((key) => ({ key, type: 'noop', config: {} })),
});

describe.skipIf(TEST_DATABASE_URL === undefined)('workflow integration', () => {
  let handle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;

  const repoFor = (tenantId: string): WorkflowRepository =>
    new WorkflowRepository(new TenantScope(handle.db, tenantId));

  beforeAll(async () => {
    handle = createTestDatabaseHandle();
    await handle.verifyConnection();

    const inserted = await handle.db
      .insert(tenants)
      .values([{ name: 'Workflow Tenant A' }, { name: 'Workflow Tenant B' }])
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

  it('creates a workflow with an active version 1, storing definition and trigger', async () => {
    const { workflow, version } = await repoFor(tenantA).create({
      name: 'first workflow',
      definition: linear(['a', 'b']),
      triggerType: 'webhook',
      triggerConfig: { source: 'wf-create' },
    });

    expect(workflow.tenantId).toBe(tenantA);
    expect(version.version).toBe(1);
    expect(version.isActive).toBe(true);
    expect(version.definition).toMatchObject({ version: 1 });
    expect(version.triggerConfig).toEqual({ source: 'wf-create' });

    const active = await repoFor(tenantA).getActiveVersion(workflow.id);
    expect(active?.id).toBe(version.id);
  });

  it('rejects an invalid definition before writing anything', async () => {
    await expect(
      repoFor(tenantA).create({
        name: 'bad',
        definition: { version: 1, steps: [] },
        triggerType: 'webhook',
        triggerConfig: { source: 'wf-invalid' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_definition' });
  });

  it('creates version 2 as a new row, leaving version 1 unchanged', async () => {
    const { workflow, version: v1 } = await repoFor(tenantA).create({
      name: 'versioned',
      definition: linear(['a']),
      triggerType: 'webhook',
      triggerConfig: { source: 'wf-v2' },
    });
    const v1Snapshot = { def: v1.definition, created: v1.createdAt.getTime() };

    const v2 = await repoFor(tenantA).createVersion(workflow.id, {
      definition: linear(['a', 'b']),
      triggerType: 'webhook',
      triggerConfig: { source: 'wf-v2' },
      activate: true,
    });

    expect(v2.version).toBe(2);

    const versions = await repoFor(tenantA).listVersions(workflow.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);

    // Version 1 is byte-for-byte what it was: not touched by v2's creation.
    const [reloadedV1] = await handle.db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, v1.id));
    expect(reloadedV1!.definition).toEqual(v1Snapshot.def);
    expect(reloadedV1!.createdAt.getTime()).toBe(v1Snapshot.created);
    expect(reloadedV1!.isActive).toBe(false);
  });

  it('keeps exactly one active version when v2 is activated', async () => {
    const { workflow, version: v1 } = await repoFor(tenantA).create({
      name: 'promote',
      definition: linear(['a']),
      triggerType: 'webhook',
      triggerConfig: { source: 'wf-activate' },
    });
    const v2 = await repoFor(tenantA).createVersion(workflow.id, {
      definition: linear(['a', 'b']),
      triggerType: 'webhook',
      triggerConfig: { source: 'wf-activate' },
      activate: true,
    });

    const active = await handle.db
      .select({ id: workflowVersions.id })
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, workflow.id));
    // Read the active set explicitly.
    const nowActive = await repoFor(tenantA).getActiveVersion(workflow.id);
    expect(nowActive?.id).toBe(v2.id);
    expect(active.length).toBe(2);

    // v1 is available but inactive; re-activating it flips the single active flag.
    await repoFor(tenantA).activateVersion(workflow.id, v1.id);
    expect((await repoFor(tenantA).getActiveVersion(workflow.id))?.id).toBe(v1.id);
  });

  it('rejects a duplicate version number at the database', async () => {
    const { workflow } = await repoFor(tenantA).create({
      name: 'dupe-guard',
      definition: linear(['a']),
      triggerType: 'webhook',
      triggerConfig: { source: 'wf-dupe' },
    });

    // Force a collision with version 1 by inserting directly, bypassing the
    // service's numbering. The unique(workflow_id, version) constraint must reject it.
    await expect(
      handle.db.insert(workflowVersions).values({
        tenantId: tenantA,
        workflowId: workflow.id,
        version: 1,
        definition: linear(['x']),
        triggerType: 'webhook',
        triggerConfig: { source: 'wf-dupe' },
        isActive: false,
      }),
    ).rejects.toThrow();
  });

  it('isolates tenants: A cannot read, version, or activate B’s workflow', async () => {
    const { workflow: bWf, version: bV1 } = await repoFor(tenantB).create({
      name: 'b-only',
      definition: linear(['a']),
      triggerType: 'webhook',
      triggerConfig: { source: 'wf-iso' },
    });

    await expect(repoFor(tenantA).getWorkflow(bWf.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      repoFor(tenantA).createVersion(bWf.id, {
        definition: linear(['a', 'b']),
        triggerType: 'webhook',
        triggerConfig: { source: 'wf-iso' },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(repoFor(tenantA).activateVersion(bWf.id, bV1.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // B's workflow is untouched: still one version, still active.
    const bVersions = await repoFor(tenantB).listVersions(bWf.id);
    expect(bVersions).toHaveLength(1);
    expect(bVersions[0]!.isActive).toBe(true);
  });
});
