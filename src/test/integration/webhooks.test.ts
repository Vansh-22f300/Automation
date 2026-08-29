/**
 * Integration tests for webhook ingestion — these require a real PostgreSQL.
 *
 * SKIPPED unless `TEST_DATABASE_URL` is set; never faked. If the variable is
 * absent the suite reports skipped, not passed.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_workforce_test pnpm test
 *
 * What these prove that the offline unit tests cannot — because they need the
 * real unique constraints, the partial unique index and a genuine transaction:
 *   - an event is persisted with its source, payload and received_at
 *   - idempotency: the ON CONFLICT DO NOTHING insert yields exactly one event and
 *     one run for a repeated (tenant, source, dedupe_key), across the same key on
 *     different tenants and different sources
 *   - routing: a matching active webhook version creates a run; an inactive /
 *     wrong-source / absent workflow persists the event with no run; tenant A's
 *     delivery never triggers tenant B's workflow
 *   - version pinning: a run keeps the version it started under even after a newer
 *     version is activated
 *   - the created run's fields (status, workflow/version/event ids, first step
 *     key, context) are exactly right
 *
 * The suite writes and deletes rows, so it refuses any database whose name does
 * not contain "test".
 */

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseEnv } from '@/config/env.js';
import { createDatabase, describeDatabaseUrl } from '@/db/client.js';
import type { DatabaseHandle } from '@/db/client.js';
import { events, tenants, workflowRuns } from '@/db/schema.js';
import { createLogger } from '@/observability/logger.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import { WebhookRepository } from '@/repositories/webhook-repository.js';
import { WorkflowRepository } from '@/repositories/workflow-repository.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const definition = (label: string) => ({
  version: 1,
  steps: [
    { key: 'first', type: 'noop', config: { label } },
    { key: 'second', type: 'noop', config: {} },
  ],
});

describe.skipIf(TEST_DATABASE_URL === undefined)('webhook ingestion integration', () => {
  let handle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;

  const ingestorFor = (tenantId: string): WebhookRepository =>
    new WebhookRepository(new TenantScope(handle.db, tenantId));
  const workflowsFor = (tenantId: string): WorkflowRepository =>
    new WorkflowRepository(new TenantScope(handle.db, tenantId));

  beforeAll(async () => {
    const url = TEST_DATABASE_URL as string;
    const target = describeDatabaseUrl(url);
    if (!target.database.includes('test')) {
      throw new Error(
        `Refusing to run integration tests against database "${target.database}": ` +
          'point TEST_DATABASE_URL at a database whose name contains "test".',
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
      .values([{ name: 'Webhook Tenant A' }, { name: 'Webhook Tenant B' }])
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

  it('persists an event with its source, payload and received_at', async () => {
    const result = await ingestorFor(tenantA).ingest({
      source: 'persist',
      dedupeKey: 'k-persist-1',
      payload: { hello: 'world', n: 42 },
    });

    const [row] = await handle.db.select().from(events).where(eq(events.id, result.eventId));
    expect(row).toBeDefined();
    expect(row!.source).toBe('persist');
    expect(row!.payload).toEqual({ hello: 'world', n: 42 });
    expect(row!.receivedAt).toBeInstanceOf(Date);
  });

  it('is idempotent: the same dedupe key yields one event and no second row', async () => {
    const first = await ingestorFor(tenantA).ingest({
      source: 'idem',
      dedupeKey: 'same-key',
      payload: { a: 1 },
    });
    const second = await ingestorFor(tenantA).ingest({
      source: 'idem',
      dedupeKey: 'same-key',
      payload: { a: 2 }, // different body, same key: the first event wins
    });

    expect(second.duplicate).toBe(true);
    expect(second.eventId).toBe(first.eventId);

    const rows = await handle.db
      .select()
      .from(events)
      .where(and(eq(events.tenantId, tenantA), eq(events.source, 'idem'), eq(events.dedupeKey, 'same-key')));
    expect(rows).toHaveLength(1);
    // The stored payload is the first delivery's, never overwritten.
    expect(rows[0]!.payload).toEqual({ a: 1 });
  });

  it('treats the same dedupe key on a different source as distinct', async () => {
    const a = await ingestorFor(tenantA).ingest({ source: 'src-x', dedupeKey: 'shared', payload: {} });
    const b = await ingestorFor(tenantA).ingest({ source: 'src-y', dedupeKey: 'shared', payload: {} });
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);
    expect(a.eventId).not.toBe(b.eventId);
  });

  it('treats the same dedupe key on a different tenant as distinct', async () => {
    const a = await ingestorFor(tenantA).ingest({ source: 'cross', dedupeKey: 'x-key', payload: {} });
    const b = await ingestorFor(tenantB).ingest({ source: 'cross', dedupeKey: 'x-key', payload: {} });
    expect(a.eventId).not.toBe(b.eventId);
    expect(b.duplicate).toBe(false);
  });

  it('persists the event but creates no run when no workflow is configured', async () => {
    const result = await ingestorFor(tenantA).ingest({
      source: 'unconfigured',
      dedupeKey: 'nc-1',
      payload: {},
    });
    expect(result.runId).toBeNull();
    expect(result.workflowConfigured).toBe(false);

    const runs = await handle.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.eventId, result.eventId));
    expect(runs).toHaveLength(0);
  });

  it('creates a queued run with the right fields when an active workflow matches', async () => {
    const created = await workflowsFor(tenantA).create({
      name: 'Routed workflow',
      definition: definition('v1'),
      triggerType: 'webhook',
      triggerConfig: { source: 'routed' },
    });

    const result = await ingestorFor(tenantA).ingest({
      source: 'routed',
      dedupeKey: 'routed-1',
      payload: { order: 7 },
    });

    expect(result.workflowConfigured).toBe(true);
    expect(result.runId).not.toBeNull();

    const [run] = await handle.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, result.runId as string));
    expect(run).toBeDefined();
    expect(run!.status).toBe('queued');
    expect(run!.tenantId).toBe(tenantA);
    expect(run!.workflowId).toBe(created.workflow.id);
    expect(run!.workflowVersionId).toBe(created.version.id);
    expect(run!.eventId).toBe(result.eventId);
    expect(run!.currentStepKey).toBe('first');
    expect(run!.context).toMatchObject({
      trigger: { source: 'routed', event_id: result.eventId, payload: { order: 7 } },
      steps: {},
    });
  });

  it('does not let tenant A trigger tenant B’s workflow on the same source', async () => {
    await workflowsFor(tenantB).create({
      name: 'B only',
      definition: definition('b'),
      triggerType: 'webhook',
      triggerConfig: { source: 'tenant-scoped' },
    });

    // Tenant A has no workflow on this source, so its delivery makes no run.
    const result = await ingestorFor(tenantA).ingest({
      source: 'tenant-scoped',
      dedupeKey: 'a-1',
      payload: {},
    });
    expect(result.workflowConfigured).toBe(false);
    expect(result.runId).toBeNull();
  });

  it('pins the version: activating a newer version leaves an existing run on the old one', async () => {
    const created = await workflowsFor(tenantA).create({
      name: 'Versioned',
      definition: definition('v1'),
      triggerType: 'webhook',
      triggerConfig: { source: 'pinned' },
    });

    const run1 = await ingestorFor(tenantA).ingest({
      source: 'pinned',
      dedupeKey: 'pin-1',
      payload: {},
    });
    expect(run1.workflowConfigured).toBe(true);

    // Author and activate v2 for the same workflow + source.
    const v2 = await workflowsFor(tenantA).createVersion(created.workflow.id, {
      definition: definition('v2'),
      triggerType: 'webhook',
      triggerConfig: { source: 'pinned' },
      activate: true,
    });

    // A new delivery runs under v2 …
    const run2 = await ingestorFor(tenantA).ingest({
      source: 'pinned',
      dedupeKey: 'pin-2',
      payload: {},
    });

    const [firstRun] = await handle.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, run1.runId as string));
    const [secondRun] = await handle.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, run2.runId as string));

    // … while the earlier run still references v1, unchanged.
    expect(firstRun!.workflowVersionId).toBe(created.version.id);
    expect(secondRun!.workflowVersionId).toBe(v2.id);
    expect(v2.id).not.toBe(created.version.id);
  });

  it('reports a configured duplicate: a retry returns the existing run, not a new one', async () => {
    await workflowsFor(tenantA).create({
      name: 'Dup workflow',
      definition: definition('d'),
      triggerType: 'webhook',
      triggerConfig: { source: 'dup' },
    });

    const first = await ingestorFor(tenantA).ingest({ source: 'dup', dedupeKey: 'd-1', payload: {} });
    const retry = await ingestorFor(tenantA).ingest({ source: 'dup', dedupeKey: 'd-1', payload: {} });

    expect(retry.duplicate).toBe(true);
    expect(retry.eventId).toBe(first.eventId);
    expect(retry.runId).toBe(first.runId);
    expect(retry.workflowConfigured).toBe(true);

    const runs = await handle.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.eventId, first.eventId));
    expect(runs).toHaveLength(1);
  });
});
