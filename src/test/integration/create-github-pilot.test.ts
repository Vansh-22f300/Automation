/**
 * Integration test for `github:prepare-pilot` against real PostgreSQL. SKIPPED (never
 * faked) without TEST_DATABASE_URL. Proves authoring goes through the real
 * WorkflowRepository + domain validation + ConnectionRepository metadata: a dry run writes
 * nothing; --commit creates exactly one ACTIVE webhook pilot (only the read tool) and
 * enqueues NO job/run; a wrong-tenant or disabled connection is refused; a duplicate is
 * refused. No LLM, GitHub, or job execution is involved.
 */
import { Writable } from 'node:stream';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { prepareGithubPilot, PILOT_WORKFLOW_NAME, type PrepareOptions } from '@/cli/create-github-pilot.js';
import { GITHUB_GET_AUTHENTICATED_USER_TOOL } from '@/connectors/github/index.js';
import type { DatabaseHandle } from '@/db/client.js';
import { connections, events, jobs, tenants, workflowRuns, workflowVersions, workflows } from '@/db/schema.js';
import { GITHUB_PROVIDER } from '@/oauth/providers/index.js';
import { ConnectionRepository } from '@/repositories/connection-repository.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import { WorkflowRepository } from '@/repositories/workflow-repository.js';
import { CredentialCipher, generateCredentialKey, parseCredentialKey } from '@/security/credential-cipher.js';
import { KeyRing } from '@/security/keyring.js';

import { TEST_DATABASE_URL, createTestDatabaseHandle } from './support.js';

const sink = (): NodeJS.WritableStream => new Writable({ write(_c, _e, cb) { cb(); } });

describe.skipIf(TEST_DATABASE_URL === undefined)('github:prepare-pilot authoring (integration)', () => {
  let handle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;
  let cipher: CredentialCipher;

  const seedConnection = async (tenantId: string, status: 'active' | 'disabled' = 'active') => {
    const conn = await new ConnectionRepository(new TenantScope(handle.db, tenantId), cipher).create({
      provider: GITHUB_PROVIDER,
      name: 'octocat',
      credential: { accessToken: 'ghp_pilot_fake', tokenType: 'bearer' },
    });
    if (status === 'disabled') {
      await handle.db.update(connections).set({ status: 'disabled' }).where(eq(connections.id, conn.id));
    }
    return conn;
  };

  const opts = (tenantId: string, connectionId: string, commit: boolean): PrepareOptions => {
    const scope = new TenantScope(handle.db, tenantId);
    const conns = new ConnectionRepository(scope, cipher);
    const wfs = new WorkflowRepository(scope);
    return {
      getMetadata: (id) => conns.getMetadata(id),
      findExistingPilot: async () => (await wfs.listWorkflows(100)).items.find((w) => w.name === PILOT_WORKFLOW_NAME)?.id ?? null,
      createWorkflow: (i) => wfs.create(i),
      tenantId,
      connectionId,
      commit,
      stdout: sink(),
    };
  };

  const workflowsFor = (tenantId: string) =>
    handle.db.select().from(workflows).where(eq(workflows.tenantId, tenantId));

  beforeAll(async () => {
    handle = createTestDatabaseHandle();
    await handle.verifyConnection();
    const key = parseCredentialKey(generateCredentialKey());
    cipher = new CredentialCipher(key, KeyRing.fromLegacyKey(key));
    const inserted = await handle.db
      .insert(tenants)
      .values([{ name: 'Pilot Tenant A' }, { name: 'Pilot Tenant B' }])
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

  // Scope cleanup strictly to this suite's own tenants; FK-safe child → parent order.
  beforeEach(async () => {
    const scope = [tenantA, tenantB];
    await handle.db.delete(jobs).where(inArray(jobs.tenantId, scope));
    await handle.db.delete(workflowRuns).where(inArray(workflowRuns.tenantId, scope));
    await handle.db.delete(events).where(inArray(events.tenantId, scope));
    await handle.db.delete(workflowVersions).where(inArray(workflowVersions.tenantId, scope));
    await handle.db.delete(workflows).where(inArray(workflows.tenantId, scope));
    await handle.db.delete(connections).where(inArray(connections.tenantId, scope));
  });

  it('--commit authors exactly one ACTIVE pilot and enqueues no job or run', async () => {
    const conn = await seedConnection(tenantA);
    const v = await prepareGithubPilot(opts(tenantA, conn.id, true));
    expect(v).toMatchObject({ outcome: 'created', reason: 'created', exitCode: 0 });

    const rows = await workflowsFor(tenantA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe(PILOT_WORKFLOW_NAME);
    expect(rows[0]!.status).toBe('active');

    const versions = await handle.db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, rows[0]!.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]!.isActive).toBe(true);
    expect(versions[0]!.triggerType).toBe('webhook');
    const def = JSON.stringify(versions[0]!.definition);
    expect(def).toContain(GITHUB_GET_AUTHENTICATED_USER_TOOL);
    expect(def).not.toContain('github_create_issue');

    // Authoring enqueues nothing — no run, no job.
    expect(await handle.db.select().from(jobs).where(eq(jobs.tenantId, tenantA))).toHaveLength(0);
    expect(await handle.db.select().from(workflowRuns).where(eq(workflowRuns.tenantId, tenantA))).toHaveLength(0);
  });

  it('dry run (default) writes no workflow', async () => {
    const conn = await seedConnection(tenantA);
    const v = await prepareGithubPilot(opts(tenantA, conn.id, false));
    expect(v).toMatchObject({ outcome: 'dry_run', reason: 'ok_dry_run', exitCode: 0 });
    expect(await workflowsFor(tenantA)).toHaveLength(0);
  });

  it('refuses a connection owned by another tenant (metadata ownership check)', async () => {
    const connB = await seedConnection(tenantB);
    const v = await prepareGithubPilot(opts(tenantA, connB.id, true));
    expect(v).toMatchObject({ outcome: 'fail', reason: 'connection_not_found', exitCode: 1 });
    expect(await workflowsFor(tenantA)).toHaveLength(0);
  });

  it('refuses a disabled connection', async () => {
    const conn = await seedConnection(tenantA, 'disabled');
    const v = await prepareGithubPilot(opts(tenantA, conn.id, true));
    expect(v).toMatchObject({ outcome: 'fail', reason: 'connection_not_active', exitCode: 1 });
    expect(await workflowsFor(tenantA)).toHaveLength(0);
  });

  it('refuses to create a second pilot (duplicate guard)', async () => {
    const conn = await seedConnection(tenantA);
    expect((await prepareGithubPilot(opts(tenantA, conn.id, true))).outcome).toBe('created');
    const second = await prepareGithubPilot(opts(tenantA, conn.id, true));
    expect(second).toMatchObject({ outcome: 'fail', reason: 'pilot_already_exists', exitCode: 1 });
    expect(await workflowsFor(tenantA)).toHaveLength(1);
  });


});
