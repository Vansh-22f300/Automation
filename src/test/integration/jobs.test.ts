/**
 * Integration tests for the PostgreSQL job queue — these require a real Postgres.
 *
 * SKIPPED unless `TEST_DATABASE_URL` is set; never faked. The whole point of the
 * queue is behaviour that only a real server exhibits — `FOR UPDATE SKIP LOCKED`
 * under genuine concurrency, transactional claims, partial-index-backed lease
 * reaping — so mocking it would prove nothing. If the variable is absent the
 * suite reports skipped, not passed.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_workforce_test pnpm test
 *
 * What these prove that the offline unit tests cannot:
 *   - claim moves exactly one pending row to running under a lease, oldest first;
 *   - a future run_at is not claimed; an empty queue yields null;
 *   - two workers claiming concurrently never receive the same job, and each
 *     gets a distinct job when several are ready (the SKIP LOCKED guarantee);
 *   - complete/fail only act on a running job; illegal transitions are rejected;
 *   - a done/failed job is terminal and never re-claimed;
 *   - the reaper returns expired-lease running jobs to pending, increments the
 *     attempt, clears the lock, and leaves live leases alone;
 *   - a tenant-scoped queue can neither claim nor mutate another tenant's jobs.
 *
 * The suite writes and deletes rows, so it refuses any database whose name does
 * not contain "test", and wipes the jobs table between tests for isolation.
 */

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseEnv } from '@/config/env.js';
import { createDatabase, describeDatabaseUrl } from '@/db/client.js';
import type { DatabaseHandle } from '@/db/client.js';
import { jobs, tenants } from '@/db/schema.js';
import { InvalidJobTransitionError } from '@/domain/queue.js';
import { createLogger } from '@/observability/logger.js';
import { PostgresJobQueue } from '@/repositories/job-queue.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import { WebhookRepository } from '@/repositories/webhook-repository.js';
import { WorkflowRepository } from '@/repositories/workflow-repository.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const definition = () => ({
  version: 1,
  steps: [
    { key: 'first', type: 'noop', config: {} },
    { key: 'second', type: 'noop', config: {} },
  ],
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(TEST_DATABASE_URL === undefined)('postgres job queue integration', () => {
  let handle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;
  let runA: string;
  let runB: string;

  const queueFor = (tenantId?: string): PostgresJobQueue =>
    new PostgresJobQueue(handle.db, tenantId === undefined ? {} : { tenantId });

  const jobById = async (id: string) => {
    const [row] = await handle.db.select().from(jobs).where(eq(jobs.id, id));
    return row;
  };

  const seedRun = async (tenantId: string, source: string): Promise<string> => {
    const workflows = new WorkflowRepository(new TenantScope(handle.db, tenantId));
    await workflows.create({
      name: `wf-${source}`,
      definition: definition(),
      triggerType: 'webhook',
      triggerConfig: { source },
    });
    const ingestor = new WebhookRepository(
      new TenantScope(handle.db, tenantId),
      new PostgresJobQueue(handle.db),
    );
    const result = await ingestor.ingest({ source, dedupeKey: `seed-${source}`, payload: {} });
    return result.runId as string;
  };

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
      .values([{ name: 'Queue Tenant A' }, { name: 'Queue Tenant B' }])
      .returning({ id: tenants.id });
    tenantA = inserted[0]!.id;
    tenantB = inserted[1]!.id;

    runA = await seedRun(tenantA, 'queue-a');
    runB = await seedRun(tenantB, 'queue-b');
  });

  afterAll(async () => {
    if (handle === undefined) return;
    for (const id of [tenantA, tenantB]) {
      if (id !== undefined) await handle.db.delete(tenants).where(eq(tenants.id, id));
    }
    await handle.close();
  });

  // A clean queue per test. Runs (and their tenants) persist; only jobs reset.
  beforeEach(async () => {
    await handle.db.delete(jobs);
  });

  describe('enqueue', () => {
    it('creates a pending job with sensible defaults and no lease', async () => {
      const { id } = await queueFor().enqueue({ tenantId: tenantA, runId: runA, stepKey: 'first' });
      const job = await jobById(id);

      expect(job).toBeDefined();
      expect(job!.status).toBe('pending');
      expect(job!.attempt).toBe(0);
      expect(job!.maxAttempts).toBe(5);
      expect(job!.lockedBy).toBeNull();
      expect(job!.leaseExpiresAt).toBeNull();
      expect(job!.runAt).toBeInstanceOf(Date);
    });

    it('rejects a job whose (tenant, run) pair does not exist (composite FK)', async () => {
      await expect(
        queueFor().enqueue({ tenantId: tenantB, runId: runA, stepKey: 'first' }),
      ).rejects.toThrow();
    });
  });

  describe('claim', () => {
    it('moves the oldest pending job to running under a lease', async () => {
      const { id } = await queueFor().enqueue({ tenantId: tenantA, runId: runA, stepKey: 'first' });

      const claimed = await queueFor().claim('worker-1');
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(id);
      expect(claimed!.lockedBy).toBe('worker-1');
      expect(claimed!.leaseExpiresAt).toBeInstanceOf(Date);

      const job = await jobById(id);
      expect(job!.status).toBe('running');
      expect(job!.lockedBy).toBe('worker-1');
      expect(job!.leaseExpiresAt).toBeInstanceOf(Date);
    });

    it('returns null when nothing is ready', async () => {
      await expect(queueFor().claim('worker-1')).resolves.toBeNull();
    });

    it('does not claim a job whose run_at is in the future', async () => {
      const future = new Date(Date.now() + 60_000);
      await queueFor().enqueue({ tenantId: tenantA, runId: runA, stepKey: 'first', runAt: future });

      await expect(queueFor().claim('worker-1')).resolves.toBeNull();
    });

    it('does not re-claim a job that is already running', async () => {
      await queueFor().enqueue({ tenantId: tenantA, runId: runA, stepKey: 'first' });
      await queueFor().claim('worker-1');

      await expect(queueFor().claim('worker-2')).resolves.toBeNull();
    });
  });

  describe('concurrency (SKIP LOCKED)', () => {
    it('never hands the same job to two workers claiming at once', async () => {
      await queueFor().enqueue({ tenantId: tenantA, runId: runA, stepKey: 'first' });

      const [a, b] = await Promise.all([queueFor().claim('w1'), queueFor().claim('w2')]);
      const claimed = [a, b].filter((c) => c !== null);

      expect(claimed).toHaveLength(1);
    });

    it('gives concurrent workers distinct jobs when several are ready', async () => {
      const q = queueFor();
      await q.enqueue({ tenantId: tenantA, runId: runA, stepKey: 'first' });
      await q.enqueue({ tenantId: tenantA, runId: runA, stepKey: 'second' });

      const [a, b] = await Promise.all([queueFor().claim('w1'), queueFor().claim('w2')]);

      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a!.id).not.toBe(b!.id);
    });
  });

  describe('complete / fail transitions', () => {
    it('completes a running job and forbids completing anything else', async () => {
      const q = queueFor();
      const { id } = await q.enqueue({ tenantId: tenantA, runId: runA, stepKey: 'first' });

      // pending → complete is illegal (never claimed).
      await expect(q.complete(id)).rejects.toBeInstanceOf(InvalidJobTransitionError);

      await q.claim('worker-1');
      await q.complete(id);
      expect((await jobById(id))!.status).toBe('done');

      // done → complete again is illegal; the job is terminal.
      await expect(q.complete(id)).rejects.toBeInstanceOf(InvalidJobTransitionError);
    });

    it('fails a running job with a structured error and clears its lease', async () => {
      const q = queueFor();
      const { id } = await q.enqueue({ tenantId: tenantA, runId: runA, stepKey: 'first' });
      await q.claim('worker-1');

      await q.fail(id, { code: 'boom', message: 'nope' });
      const job = await jobById(id);
      expect(job!.status).toBe('failed');
      expect(job!.lastError).toEqual({ code: 'boom', message: 'nope' });
      expect(job!.lockedBy).toBeNull();
      expect(job!.leaseExpiresAt).toBeNull();

      // failed → running is not automatic, and failed cannot be failed again.
      await expect(q.fail(id, { code: 'again' })).rejects.toBeInstanceOf(InvalidJobTransitionError);
    });

    it('never re-claims a terminal job', async () => {
      const q = queueFor();
      const { id } = await q.enqueue({ tenantId: tenantA, runId: runA, stepKey: 'first' });
      await q.claim('worker-1');
      await q.complete(id);

      await expect(queueFor().claim('worker-2')).resolves.toBeNull();
    });
  });

  describe('reaper (requeueExpired)', () => {
    it('returns an expired-lease job to pending, incrementing its attempt', async () => {
      // A one-millisecond lease so it is expired almost immediately.
      const shortLease = new PostgresJobQueue(handle.db, { leaseDurationMs: 1 });
      const { id } = await shortLease.enqueue({ tenantId: tenantA, runId: runA, stepKey: 'first' });
      await shortLease.claim('worker-dead');

      await sleep(20);
      const requeued = await queueFor().requeueExpired();
      expect(requeued).toBeGreaterThanOrEqual(1);

      const job = await jobById(id);
      expect(job!.status).toBe('pending');
      expect(job!.attempt).toBe(1);
      expect(job!.lockedBy).toBeNull();
      expect(job!.leaseExpiresAt).toBeNull();
    });

    it('leaves a job with a live lease alone', async () => {
      const q = queueFor(); // default five-minute lease
      const { id } = await q.enqueue({ tenantId: tenantA, runId: runA, stepKey: 'first' });
      await q.claim('worker-1');

      await expect(q.requeueExpired()).resolves.toBe(0);
      expect((await jobById(id))!.status).toBe('running');
    });
  });

  describe('tenant isolation', () => {
    it('a tenant-scoped queue does not claim another tenant’s job', async () => {
      await queueFor().enqueue({ tenantId: tenantA, runId: runA, stepKey: 'first' });

      // Tenant B's scoped queue sees only tenant B's jobs — none are pending.
      await expect(queueFor(tenantB).claim('worker-b')).resolves.toBeNull();
    });

    it('a tenant-scoped queue cannot complete or fail another tenant’s job', async () => {
      const { id } = await queueFor().enqueue({ tenantId: tenantA, runId: runA, stepKey: 'first' });
      await queueFor().claim('worker-1'); // now running

      // B's scoped queue matches no row (tenant predicate excludes it).
      await expect(queueFor(tenantB).complete(id)).rejects.toBeInstanceOf(InvalidJobTransitionError);
      await expect(queueFor(tenantB).fail(id, { code: 'x' })).rejects.toBeInstanceOf(
        InvalidJobTransitionError,
      );

      // The job is untouched and still completable by the unscoped worker.
      expect((await jobById(id))!.status).toBe('running');
      await queueFor().complete(id);
      expect((await jobById(id))!.status).toBe('done');
    });

    it('a tenant-scoped queue only reaps its own expired jobs', async () => {
      const shortA = new PostgresJobQueue(handle.db, { leaseDurationMs: 1, tenantId: tenantA });
      const shortB = new PostgresJobQueue(handle.db, { leaseDurationMs: 1 });
      const a = await shortA.enqueue({ tenantId: tenantA, runId: runA, stepKey: 'first' });
      const b = await shortB.enqueue({ tenantId: tenantB, runId: runB, stepKey: 'first' });
      await shortA.claim('worker-a');
      await shortB.claim('worker-b');

      await sleep(20);
      // Scoped to A: reaps A's job only.
      const requeued = await new PostgresJobQueue(handle.db, { tenantId: tenantA }).requeueExpired();
      expect(requeued).toBe(1);

      expect((await jobById(a.id))!.status).toBe('pending');
      expect((await jobById(b.id))!.status).toBe('running');
    });
  });
});
