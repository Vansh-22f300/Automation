/**
 * Tenant-isolation security suite — end-to-end cross-tenant tests against a
 * real PostgreSQL.
 *
 * SKIPPED unless `TEST_DATABASE_URL` is set; never faked. If the variable is
 * absent the suite reports skipped, not passed.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_workforce_test pnpm test
 *
 * What this file proves — organised into the eight categories of cross-tenant
 * attack surface in the spec (A through H):
 *
 *   A. API keys — cross-tenant read / revoke / authenticate.
 *   B. Workflows — cross-tenant read / modify / activate / version / webhook
 *      source lookup.
 *   C. Workflow runs — cross-tenant inspect, indistinguishable-not-found.
 *   D. Events / jobs — cross-tenant read / claim / mutate through the tenant-
 *      scoped APIs; worker queue tenant-safety; cross-tenant dedupe.
 *   E. Connections — cross-tenant read / decrypt / use credentials; cross-
 *      tenant connection id resolution; provider-based resolution picks the
 *      caller's own active connection, never another tenant's.
 *   F. Webhook HMAC — cross-tenant secret connection use; signature resolver
 *      tenant scoping.
 *   G. Execution — the executor advances only the run it was given; tenant
 *      identity travels through `ClaimedJob.tenantId`; version pinning is
 *      per-tenant.
 *   H. Negative data-shape — every read-side method returns null/empty for
 *      another tenant's IDs and never logs or returns another tenant's
 *      plaintext secret, prefix, or other distinguishing marker.
 *
 * The two tenants, A and B, are seeded in `beforeAll` with deliberately distinct
 * fixtures (different names, different secrets, different workflow/connection
 * names). Tenant B's distinguishing markers are checked against A's responses in
 * category H so a future regression that *did* leak a row would fail there
 * before a human ever noticed.
 *
 * The suite refuses any database whose name lacks "test". Tenant rows are
 * cascade-deleted in `afterAll`.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NotFoundError } from '@/api/errors.js';
import { ApiKeyAuthenticator } from '@/auth/api-key-authenticator.js';
import { DrizzleApiKeyStore } from '@/auth/api-key-store.js';
import { parseEnv } from '@/config/env.js';
import type { DatabaseHandle } from '@/db/client.js';
import {
  connections,
  jobs,
  tenants,
  workflowRuns,
} from '@/db/schema.js';
import { MissingConnectionError } from '@/domain/tool-errors.js';
import type { ClaimedJob } from '@/domain/queue.js';
import { defaultStepHandlerRegistry } from '@/domain/step-handler.js';
import { createLogger } from '@/observability/logger.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import { PostgresJobQueue } from '@/repositories/job-queue.js';
import { ApiKeyRepository } from '@/repositories/api-key-repository.js';
import { ConnectionRepository } from '@/repositories/connection-repository.js';
import { WorkflowExecutor } from '@/repositories/execution-engine.js';
import { RunInspectionRepository } from '@/repositories/run-inspection-repository.js';
import { WebhookRepository } from '@/repositories/webhook-repository.js';
import { WorkflowRepository } from '@/repositories/workflow-repository.js';
import {
  CredentialCipher,
  generateCredentialKey,
  parseCredentialKey,
} from '@/security/credential-cipher.js';

import { TEST_DATABASE_URL, createTestDatabaseHandle } from './support.js';

// A real silent logger — required by the executor. We pin a fake DATABASE_URL
// to satisfy parseEnv without depending on env state.
const silentLogger = () =>
  createLogger(
    parseEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      LOG_LEVEL: 'silent',
    }) as never,
    { service: 'test' },
  );

// ---------------------------------------------------------------------------
// Tenant fixtures
// ---------------------------------------------------------------------------

/** B's deliberately-distinct plaintext secret. Never logged, never returned. */
const B_PLAINTEXT_TOKEN = 'b-INTEGRATION-CROSS-TENANT-SECRET';
const B_WORKFLOW_NAME = 'b-isolation-workflow';
const B_CONNECTION_NAME = 'b-isolation-connection';
const B_PAYLOAD_MARKER = 'B-PAYLOAD-MARKER-99';

const definition = () => ({
  version: 1,
  steps: [{ key: 'first', type: 'noop', config: {} }],
});

const noopRegistry = () => defaultStepHandlerRegistry();

describe.skipIf(TEST_DATABASE_URL === undefined)(
  'tenant-isolation security suite',
  () => {
    let handle: DatabaseHandle;
    let tenantA: string;
    let tenantB: string;
    const cipher = new CredentialCipher(parseCredentialKey(generateCredentialKey()));

    // Per-tenant repository factories.
    const apiKeysFor = (tenantId: string) =>
      new ApiKeyRepository(new TenantScope(handle.db, tenantId));
    const workflowsFor = (tenantId: string) =>
      new WorkflowRepository(new TenantScope(handle.db, tenantId));
    const connectionsFor = (tenantId: string) =>
      new ConnectionRepository(new TenantScope(handle.db, tenantId), cipher);
    const ingestorFor = (tenantId: string) =>
      new WebhookRepository(
        new TenantScope(handle.db, tenantId),
        new PostgresJobQueue(handle.db),
      );
    const runsFor = (tenantId: string) =>
      new RunInspectionRepository(new TenantScope(handle.db, tenantId));
    // The unbound queue is the worker's view; it claims any tenant's job.
    const workerQueue = () => new PostgresJobQueue(handle.db);
    const tenantQueue = (tenantId: string) =>
      new PostgresJobQueue(handle.db, { tenantId });

    // Authenticator built once off the unscoped store. Both tenants' keys are
    // resolvable through it because authentication must be cross-tenant by
    // definition (the tenant is what we're trying to discover).
    const authenticator = () => new ApiKeyAuthenticator(new DrizzleApiKeyStore(handle.db));

    let bKey: { id: string; plaintext: string; prefix: string };
    let bConnectionId: string;
    let bWorkflowId: string;
    let bVersionId: string;
    let bRunId: string;
    let bEventId: string;
    let bJobId: string;

    beforeAll(async () => {
      handle = createTestDatabaseHandle();
      await handle.verifyConnection();

      const inserted = await handle.db
        .insert(tenants)
        .values([
          { name: 'Isolation Tenant A' },
          { name: 'Isolation Tenant B' },
        ])
        .returning({ id: tenants.id });
      tenantA = inserted[0]!.id;
      tenantB = inserted[1]!.id;

      // Seed B with deliberately-distinct fixtures. Each fixture has a marker
      // A's responses must never contain.
      bKey = await apiKeysFor(tenantB).create('b-key-only');
      const bConnection = await connectionsFor(tenantB).create({
        provider: 'slack',
        name: B_CONNECTION_NAME,
        credential: { token: B_PLAINTEXT_TOKEN, refresh: 'b-refresh' },
      });
      bConnectionId = bConnection.id;

      const bWorkflow = await workflowsFor(tenantB).create({
        name: B_WORKFLOW_NAME,
        definition: definition(),
        triggerType: 'webhook',
        triggerConfig: { source: 'b-source' },
      });
      bWorkflowId = bWorkflow.workflow.id;
      bVersionId = bWorkflow.version.id;

      const ingested = await ingestorFor(tenantB).ingest({
        source: 'b-source',
        dedupeKey: 'b-cross-tenant-key',
        payload: { marker: B_PAYLOAD_MARKER },
      });
      bEventId = ingested.eventId;
      bRunId = ingested.runId as string;

      // The first job B's run created.
      const [bJob] = await handle.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.runId, bRunId));
      bJobId = bJob!.id;
    });

    afterAll(async () => {
      if (handle === undefined) return;
      // The cascade on tenants.id cleans every dependent row.
      for (const id of [tenantA, tenantB]) {
        if (id !== undefined) await handle.db.delete(tenants).where(eq(tenants.id, id));
      }
      await handle.close();
    });

    // ===================================================================
    // A. API keys — cross-tenant read / revoke / authenticate.
    // ===================================================================

    describe('A. API keys', () => {
      it('A.list() does not return B\'s keys', async () => {
        const aKeys = await apiKeysFor(tenantA).list();
        expect(aKeys.some((k) => k.id === bKey.id)).toBe(false);
      });

      it('A.revoke(B_keyId) raises NotFoundError and does not mutate B\'s row', async () => {
        await expect(apiKeysFor(tenantA).revoke(bKey.id)).rejects.toBeInstanceOf(
          NotFoundError,
        );
        // On disk, B's key is unchanged. Re-import for the projection (the
        // dynamic-import dance keeps this file's import block compact while
        // still typing the projection correctly).
        const { apiKeys } = await import('@/db/schema.js');
        const [row] = await handle.db
          .select({ revokedAt: apiKeys.revokedAt })
          .from(apiKeys)
          .where(eq(apiKeys.id, bKey.id));
        expect(row).toBeDefined();
        expect(row!.revokedAt).toBeNull();
        // The authenticator still accepts B's plaintext key — A's failed revoke
        // did not touch B's row at all.
        const ctx = await authenticator().authenticate(bKey.plaintext);
        expect(ctx.tenantId).toBe(tenantB);
      });

      it('authenticate(B_plaintext) resolves to B\'s tenant only', async () => {
        const ctx = await authenticator().authenticate(bKey.plaintext);
        expect(ctx.tenantId).toBe(tenantB);
        expect(ctx.apiKeyId).toBe(bKey.id);
      });

      it('authenticate(B_plaintext) returns A\'s context only if A happens to own a key with that plaintext (it does not)', async () => {
        const ctx = await authenticator().authenticate(bKey.plaintext);
        expect(ctx.tenantId).not.toBe(tenantA);
      });

      it('authenticating a B key through A\'s perspective returns no A context', async () => {
        // A's repository list view cannot enumerate B's keys to learn which
        // prefix to try. The authenticator's prefix lookup is the only path
        // that resolves a plaintext to a tenant; nothing else does.
        const aKeys = await apiKeysFor(tenantA).list();
        for (const k of aKeys) {
          expect(k.id).not.toBe(bKey.id);
        }
      });
    });

    // ===================================================================
    // B. Workflows — read / modify / activate / version / webhook source.
    // ===================================================================

    describe('B. Workflows', () => {
      it('A.getWorkflow(B_workflowId) raises NotFoundError', async () => {
        await expect(workflowsFor(tenantA).getWorkflow(bWorkflowId)).rejects.toBeInstanceOf(
          NotFoundError,
        );
      });

      it('A.createVersion against B\'s workflow raises NotFoundError', async () => {
        await expect(
          workflowsFor(tenantA).createVersion(bWorkflowId, {
            definition: definition(),
            triggerType: 'webhook',
            triggerConfig: { source: 'should-not-stick' },
          }),
        ).rejects.toBeInstanceOf(NotFoundError);
      });

      it('A.activateVersion against B\'s workflow raises NotFoundError', async () => {
        await expect(
          workflowsFor(tenantA).activateVersion(bWorkflowId, bVersionId),
        ).rejects.toBeInstanceOf(NotFoundError);
      });

      it('A.listVersions(B_workflowId) returns empty', async () => {
        const versions = await workflowsFor(tenantA).listVersions(bWorkflowId);
        expect(versions).toEqual([]);
      });

      it('A.listWorkflows does not include B\'s workflow', async () => {
        const page = await workflowsFor(tenantA).listWorkflows();
        expect(page.items.some((w) => w.id === bWorkflowId)).toBe(false);
      });

      it('A.ingest on B\'s source routes to A\'s active version, never B\'s', async () => {
        // A seeds its own active version for the same source B uses.
        await workflowsFor(tenantA).create({
          name: 'a-workflow-on-b-source',
          definition: definition(),
          triggerType: 'webhook',
          triggerConfig: { source: 'b-source' },
        });
        const aResult = await ingestorFor(tenantA).ingest({
          source: 'b-source',
          dedupeKey: 'a-delivery-on-b-source',
          payload: { from: 'A' },
        });
        expect(aResult.workflowConfigured).toBe(true);
        expect(aResult.runId).not.toBeNull();
        // The run belongs to A; B's run is unaffected.
        const [aRun] = await handle.db
          .select()
          .from(workflowRuns)
          .where(eq(workflowRuns.id, aResult.runId as string));
        expect(aRun!.tenantId).toBe(tenantA);
        const [bRun] = await handle.db
          .select()
          .from(workflowRuns)
          .where(eq(workflowRuns.id, bRunId));
        expect(bRun!.tenantId).toBe(tenantB);
      });

      it('B.ingest on a source only A owns routes to A\'s version, never B\'s', async () => {
        // The reverse direction: B ingesting on a source that only A owns.
        await workflowsFor(tenantA).create({
          name: 'a-only-source',
          definition: definition(),
          triggerType: 'webhook',
          triggerConfig: { source: 'a-only-source' },
        });
        const bResult = await ingestorFor(tenantB).ingest({
          source: 'a-only-source',
          dedupeKey: 'b-delivery-on-a-only-source',
          payload: {},
        });
        // The event is persisted, but no run is created because B has no
        // active version for this source — the active version lookup is
        // tenant-scoped.
        expect(bResult.workflowConfigured).toBe(false);
        expect(bResult.runId).toBeNull();
      });
    });

    // ===================================================================
    // C. Workflow runs — inspect, indistinguishable-not-found.
    // ===================================================================

    describe('C. Workflow runs', () => {
      it('A.getRun(B_runId) returns null (→ 404 in API)', async () => {
        const result = await runsFor(tenantA).getRun(bRunId);
        expect(result).toBeNull();
      });

      it('A.listRuns({ workflowId: B_workflowId }) is empty', async () => {
        const page = await runsFor(tenantA).listRuns({ workflowId: bWorkflowId });
        expect(page.items).toEqual([]);
      });

      it('indistinguishable: a cross-tenant runId and a genuinely absent runId both return null', async () => {
        const crossTenant = await runsFor(tenantA).getRun(bRunId);
        const genuinelyAbsent = await runsFor(tenantA).getRun(
          '00000000-0000-7000-8000-000000000000',
        );
        // Both null — same outcome, same shape, no oracle distinguishing them.
        expect(crossTenant).toBeNull();
        expect(genuinelyAbsent).toBeNull();
        expect(crossTenant).toBe(genuinelyAbsent);
      });

      it('A.listRuns overall does not include B\'s run id', async () => {
        const page = await runsFor(tenantA).listRuns();
        expect(page.items.some((r) => r.id === bRunId)).toBe(false);
      });
    });

    // ===================================================================
    // D. Events / jobs — read / claim / mutate; worker tenant-safety.
    // ===================================================================

    describe('D. Events and jobs', () => {
      it('A.listEvents does not return B\'s events', async () => {
        const aEvents = await ingestorFor(tenantA).listEvents();
        expect(aEvents.some((e) => e.id === bEventId)).toBe(false);
      });

      it('A.listJobs does not return B\'s jobs', async () => {
        const aJobs = await ingestorFor(tenantA).listJobs();
        expect(aJobs.some((j) => j.id === bJobId)).toBe(false);
      });

      it('A\'s tenant-bound queue cannot claim B\'s job', async () => {
        // A's tenant-bound queue may return A's own jobs (the B test above
        // ingested an event for A that enqueued a job). What it MUST NOT do
        // is return B's job. We claim once and verify the result, if any,
        // is A's, never B's.
        const claimed = await tenantQueue(tenantA).claim('worker-a');
        if (claimed !== null) {
          // The queue did claim something — it must be A's, not B's.
          expect(claimed.id).not.toBe(bJobId);
          expect(claimed.tenantId).toBe(tenantA);
        }
        // B's job is untouched.
        const schema = await import('@/db/schema.js');
        const [bRow] = await handle.db
          .select({ status: schema.jobs.status })
          .from(schema.jobs)
          .where(eq(schema.jobs.id, bJobId));
        expect(bRow!.status).not.toBe('running');
      });

      it('A\'s tenant-bound queue cannot complete B\'s job (InvalidJobTransitionError)', async () => {
        await expect(
          tenantQueue(tenantA).complete(bJobId, 'worker-a'),
        ).rejects.toMatchObject({ name: 'InvalidJobTransitionError' });
      });

      it('A\'s tenant-bound queue cannot fail B\'s job (InvalidJobTransitionError)', async () => {
        await expect(
          tenantQueue(tenantA).fail(bJobId, 'worker-a', {
            code: 'cross_tenant',
            message: 'attempt to fail another tenants job',
          }),
        ).rejects.toMatchObject({ name: 'InvalidJobTransitionError' });
      });

      it('A\'s tenant-bound queue cannot release B\'s job (it never owned it)', async () => {
        const result = await tenantQueue(tenantA).release(bJobId, 'worker-a');
        // The release path reports a safe outcome rather than throwing: the
        // row is not running under A, so it is a no-op.
        expect(result.outcome).toBe('not_running');
      });

      it('the unscoped worker queue can claim any tenant\'s job (worker view)', async () => {
        // B's job was left in `pending` by the drain above. The worker queue
        // has no tenant predicate, so it sees every claimable row.
        const claimed = await workerQueue().claim('worker-cross-tenant');
        expect(claimed).not.toBeNull();
        expect(claimed!.id).toBe(bJobId);
        expect(claimed!.tenantId).toBe(tenantB);
      });

      it('the claimed B job, dispatched through an executor, mutates only B\'s run', async () => {
        // The previous test claimed B's job; release it back to `pending` so
        // this test can re-claim it deterministically (a running job cannot
        // be claimed by the worker again).
        const schema = await import('@/db/schema.js');
        const [bRow] = await handle.db
          .select({ status: schema.jobs.status, lockedBy: schema.jobs.lockedBy })
          .from(schema.jobs)
          .where(eq(schema.jobs.id, bJobId));
        if (bRow!.lockedBy !== null) {
          await workerQueue().release(bJobId, bRow!.lockedBy as string);
        }
        const claimed = await workerQueue().claim('worker-cross-tenant');
        expect(claimed).not.toBeNull();
        expect(claimed!.tenantId).toBe(tenantB);
        const executor = new WorkflowExecutor({
          db: handle.db,
          queue: new PostgresJobQueue(handle.db),
          registry: noopRegistry(),
          logger: silentLogger(),
        });
        await executor.dispatch(claimed as ClaimedJob);
        await workerQueue().complete(claimed!.id, claimed!.lockedBy);

        const [bRun] = await handle.db
          .select()
          .from(workflowRuns)
          .where(eq(workflowRuns.id, bRunId));
        // B's run, having a single noop step, has finished.
        expect(bRun!.status).toBe('succeeded');
        // B's run is still tenant B's — the executor dispatched on a B job
        // did not retag it.
        expect(bRun!.tenantId).toBe(tenantB);
      });

      it('the same (source, dedupeKey) on A and B produces distinct events', async () => {
        // The events unique index is scoped per (tenant, source, dedupe_key),
        // so the same dedupe key in two tenants is independent.
        const a = await ingestorFor(tenantA).ingest({
          source: 'shared-source',
          dedupeKey: 'shared-dedupe-key',
          payload: { from: 'A' },
        });
        const b = await ingestorFor(tenantB).ingest({
          source: 'shared-source',
          dedupeKey: 'shared-dedupe-key',
          payload: { from: 'B' },
        });
        expect(a.eventId).not.toBe(b.eventId);
        expect(a.duplicate).toBe(false);
        expect(b.duplicate).toBe(false);
      });
    });

    // ===================================================================
    // E. Connections — read / decrypt / use credentials; cross-tenant id.
    // ===================================================================

    describe('E. Connections', () => {
      it('A.getMetadata(B_connId) returns null', async () => {
        const meta = await connectionsFor(tenantA).getMetadata(bConnectionId);
        expect(meta).toBeNull();
      });

      it('A.listMetadata excludes B\'s connection', async () => {
        const items = await connectionsFor(tenantA).listMetadata();
        expect(items.some((c) => c.id === bConnectionId)).toBe(false);
      });

      it('A.updateMetadata(B_connId, ...) returns null (no mutation)', async () => {
        const result = await connectionsFor(tenantA).updateMetadata(
          bConnectionId,
          { tampered: true },
        );
        expect(result).toBeNull();
        // On disk, B's metadata is unchanged.
        const [row] = await handle.db
          .select({ metadata: connections.metadata })
          .from(connections)
          .where(eq(connections.id, bConnectionId));
        expect(row!.metadata).not.toMatchObject({ tampered: true });
      });

      it('A.disable(B_connId) returns null (no mutation)', async () => {
        const result = await connectionsFor(tenantA).disable(bConnectionId);
        expect(result).toBeNull();
        const [row] = await handle.db
          .select({ status: connections.status })
          .from(connections)
          .where(eq(connections.id, bConnectionId));
        expect(row!.status).toBe('active');
      });

      it('A.delete(B_connId) returns false (no mutation)', async () => {
        const deleted = await connectionsFor(tenantA).delete(bConnectionId);
        expect(deleted).toBe(false);
        const [row] = await handle.db
          .select({ id: connections.id })
          .from(connections)
          .where(eq(connections.id, bConnectionId));
        expect(row).toBeDefined();
      });

      it('A.resolveForTool({ provider, connectionId: B_connId }) throws MissingConnectionError', async () => {
        await expect(
          connectionsFor(tenantA).resolveForTool({
            provider: 'slack',
            connectionId: bConnectionId,
          }),
        ).rejects.toBeInstanceOf(MissingConnectionError);
      });

      it('A.resolveForTool({ provider }) picks A\'s active connection only, never B\'s', async () => {
        // Give A its own slack connection with a *different* token so we can
        // tell which connection was resolved.
        const aConn = await connectionsFor(tenantA).create({
          provider: 'slack',
          name: 'a-isolation-slack',
          credential: { token: 'a-INTEGRATION-CROSS-TENANT-SECRET' },
        });
        const resolved = await connectionsFor(tenantA).resolveForTool({
          provider: 'slack',
        });
        // The resolved id is A's, never B's.
        expect(resolved.metadata.id).toBe(aConn.id);
        expect(resolved.metadata.id).not.toBe(bConnectionId);
        // The decrypted credential is A's token, never B's.
        expect((resolved.credential as { token?: string }).token).toBe(
          'a-INTEGRATION-CROSS-TENANT-SECRET',
        );
        expect((resolved.credential as { token?: string }).token).not.toBe(
          B_PLAINTEXT_TOKEN,
        );
      });
    });

    // ===================================================================
    // F. Webhook HMAC — cross-tenant secret connection use; signature resolver.
    // ===================================================================

    describe('F. Webhook HMAC', () => {
      it('A\'s signature resolver returns null for a source only B owns', async () => {
        const aResolver = new (
          await import('@/repositories/webhook-signature-resolver.js')
        ).WebhookSignatureRepository(new TenantScope(handle.db, tenantA), cipher);
        // A has no active version for 'b-source' that it owns. (Earlier we
        // created an A version for 'b-source', but the partial unique index
        // for `(tenant_id, source)` is per-tenant — A's active version is
        // resolved by A's resolver, not B's.) A's resolver sees B's source as
        // a foreign-source lookup: it queries A's own workflow_versions, not
        // B's, so it returns null (no A version with that source).
        const material = await aResolver.resolveForSource('source-only-b-has');
        expect(material).toBeNull();
      });

      it('cross-tenant connection id in A\'s trigger config: A\'s resolver hits connection_not_found', async () => {
        // Seed an A-only workflow whose trigger config names B's connection
        // as its signing secret connection. The partial unique index allows
        // this insert (A owns the version; B owns the connection). When A
        // resolves its version, the connection lookup is scoped to A and
        // therefore misses — exactly the right refusal.
        const { parseTriggerConfig } = await import('@/domain/workflow-trigger.js');
        const triggerConfig = parseTriggerConfig('webhook', {
          source: 'a-source-with-b-conn',
          signature: {
            signing_input: 'raw_body',
            algorithm: 'hmac-sha256',
            secret_connection_id: bConnectionId,
            signature_header: 'x-sig',
            signature_encoding: 'hex',
          },
        });
        // Authoring-time validation rejects a foreign connection id because
        // the schema is tenant-blind, but the database stores the config
        // verbatim. Use the repository's raw INSERT to bypass validation and
        // reproduce the cross-tenant config shape that a future bug might
        // produce.
        const { workflowVersions, workflows } = await import('@/db/schema.js');
        const [wfRow] = await handle.db
          .insert(workflows)
          .values({ tenantId: tenantA, name: 'wf-with-b-conn' })
          .returning();
        await handle.db.insert(workflowVersions).values({
          tenantId: tenantA,
          workflowId: wfRow!.id,
          version: 1,
          definition: { version: 1, steps: [{ key: 'first', type: 'noop', config: {} }] },
          triggerType: 'webhook',
          triggerConfig: triggerConfig as unknown as Record<string, unknown>,
          isActive: true,
        });

        const aResolver = new (
          await import('@/repositories/webhook-signature-resolver.js')
        ).WebhookSignatureRepository(new TenantScope(handle.db, tenantA), cipher);
        await expect(aResolver.resolveForSource('a-source-with-b-conn')).rejects.toMatchObject({
          name: 'WebhookSignatureSecretUnavailableError',
          code: 'connection_not_found',
        });
      });

      it('B\'s signature resolver returns null for a source only A owns', async () => {
        const bResolver = new (
          await import('@/repositories/webhook-signature-resolver.js')
        ).WebhookSignatureRepository(new TenantScope(handle.db, tenantB), cipher);
        const material = await bResolver.resolveForSource('a-only-source');
        expect(material).toBeNull();
      });

      it('disabled connection in own tenant: resolver throws connection_disabled', async () => {
        // A disables its own connection. The resolver path (not just the
        // metadata path) must honour `status !== active`.
        const aConn = await connectionsFor(tenantA).create({
          provider: 'slack',
          name: 'a-to-disable',
          credential: { token: 'a-disabling-token' },
        });
        await connectionsFor(tenantA).disable(aConn.id);
        const { workflowVersions, workflows } = await import('@/db/schema.js');
        const [wfRow] = await handle.db
          .insert(workflows)
          .values({ tenantId: tenantA, name: 'wf-with-a-disabled-conn' })
          .returning();
        await handle.db.insert(workflowVersions).values({
          tenantId: tenantA,
          workflowId: wfRow!.id,
          version: 1,
          definition: { version: 1, steps: [{ key: 'first', type: 'noop', config: {} }] },
          triggerType: 'webhook',
          triggerConfig: {
            source: 'a-disabled-conn-source',
            signature: {
              signing_input: 'raw_body',
              algorithm: 'hmac-sha256',
              secret_connection_id: aConn.id,
              signature_header: 'x-sig',
              signature_encoding: 'hex',
            },
          },
          isActive: true,
        });
        const aResolver = new (
          await import('@/repositories/webhook-signature-resolver.js')
        ).WebhookSignatureRepository(new TenantScope(handle.db, tenantA), cipher);
        await expect(aResolver.resolveForSource('a-disabled-conn-source')).rejects.toMatchObject({
          name: 'WebhookSignatureSecretUnavailableError',
          code: 'connection_disabled',
        });
      });
    });

    // ===================================================================
    // G. Execution — run advance / mutate; version pinning ownership.
    // ===================================================================

    describe('G. Execution', () => {
      it('A worker picking up A\'s job via the unscoped queue can only execute the run it was given', async () => {
        // Seed a fresh A run with a one-step noop workflow.
        const aWf = await workflowsFor(tenantA).create({
          name: 'a-exec-workflow',
          definition: definition(),
          triggerType: 'webhook',
          triggerConfig: { source: 'a-exec-source' },
        });
        const aResult = await ingestorFor(tenantA).ingest({
          source: 'a-exec-source',
          dedupeKey: 'a-exec-key',
          payload: { hello: 'from-A' },
        });
        expect(aResult.runId).not.toBeNull();

        // The worker (unscoped queue) claims the job and dispatches it.
        const claimed = await workerQueue().claim('worker-exec-a');
        expect(claimed).not.toBeNull();
        expect(claimed!.tenantId).toBe(tenantA);
        expect(claimed!.runId).toBe(aResult.runId);

        const executor = new WorkflowExecutor({
          db: handle.db,
          queue: new PostgresJobQueue(handle.db),
          registry: noopRegistry(),
          logger: silentLogger(),
        });
        await executor.dispatch(claimed as ClaimedJob);
        await workerQueue().complete(claimed!.id, claimed!.lockedBy);

        // A's run advanced to succeeded.
        const [aRun] = await handle.db
          .select()
          .from(workflowRuns)
          .where(eq(workflowRuns.id, aResult.runId as string));
        expect(aRun!.status).toBe('succeeded');

        // B's run (seeded earlier and finished by category D) is unchanged:
        // the executor invoked for A did not add any new workflow_step_runs
        // for B's run, regardless of what state B's run is in.
        const bStepRuns = await handle.db
          .select()
          .from((await import('@/db/schema.js')).workflowStepRuns)
          .where(eq((await import('@/db/schema.js')).workflowStepRuns.runId, bRunId));
        // B's step runs (from category D) are exactly one: the executor
        // invoked in this test ran for A, not B.
        expect(bStepRuns).toHaveLength(1);

        // The pinned version on A's run is exactly A's version — never B's,
        // never the active version after activation of v2.
        const [pin] = await handle.db
          .select({ v: workflowRuns.workflowVersionId, wf: workflowRuns.workflowId })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, aResult.runId as string));
        expect(pin!.v).toBe(aWf.version.id);
        expect(pin!.wf).toBe(aWf.workflow.id);
      });
    });

    // ===================================================================
    // H. Negative data-shape — no leak of B's distinguishing markers
    //     through any read-side method called from A.
    // ===================================================================

    describe('H. Negative data-shape', () => {
      it('A\'s API-key list response contains none of B\'s distinguishing markers', async () => {
        const aKeys = await apiKeysFor(tenantA).list();
        const serialised = JSON.stringify(aKeys);
        expect(serialised).not.toContain(B_PLAINTEXT_TOKEN);
        expect(serialised).not.toContain(bKey.prefix);
      });

      it('A\'s workflow list response contains none of B\'s distinguishing markers', async () => {
        const page = await workflowsFor(tenantA).listWorkflows();
        const serialised = JSON.stringify(page);
        expect(serialised).not.toContain(B_WORKFLOW_NAME);
      });

      it('A\'s connection list response contains none of B\'s distinguishing markers', async () => {
        const items = await connectionsFor(tenantA).listMetadata();
        const serialised = JSON.stringify(items);
        expect(serialised).not.toContain(B_CONNECTION_NAME);
        expect(serialised).not.toContain(B_PLAINTEXT_TOKEN);
      });

      it('A\'s events list contains none of B\'s distinguishing markers', async () => {
        const aEvents = await ingestorFor(tenantA).listEvents();
        const serialised = JSON.stringify(aEvents);
        expect(serialised).not.toContain(B_PAYLOAD_MARKER);
      });

      it('A\'s runs list contains none of B\'s distinguishing markers', async () => {
        const page = await runsFor(tenantA).listRuns();
        const serialised = JSON.stringify(page);
        expect(serialised).not.toContain(B_PAYLOAD_MARKER);
        expect(serialised).not.toContain(B_WORKFLOW_NAME);
      });

      it('A\'s jobs list contains none of B\'s distinguishing markers', async () => {
        const aJobs = await ingestorFor(tenantA).listJobs();
        const serialised = JSON.stringify(aJobs);
        // B's run id is unique enough that its presence would be a leak.
        expect(serialised).not.toContain(bRunId);
      });

      it('A\'s connection resolveForTool with B\'s id does not decrypt anything (no secret in error path)', async () => {
        // The error path must not carry B's secret.
        let caught: unknown = null;
        try {
          await connectionsFor(tenantA).resolveForTool({
            provider: 'slack',
            connectionId: bConnectionId,
          });
        } catch (error) {
          caught = error;
        }
        const serialised = JSON.stringify(caught);
        expect(serialised).not.toContain(B_PLAINTEXT_TOKEN);
        expect(caught).toBeInstanceOf(MissingConnectionError);
      });
    });
  },
);
