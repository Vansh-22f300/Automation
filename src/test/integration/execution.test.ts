/**
 * Integration tests for the workflow execution engine — these require a real
 * PostgreSQL and are SKIPPED (never faked) unless `TEST_DATABASE_URL` is set.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_workforce_test pnpm test
 *
 * What they prove that the offline unit tests cannot — the engine's behaviour
 * against genuine transactions, foreign keys and the idempotency index:
 *
 *   - a 1/2/3-step noop workflow runs to `succeeded`, one step per job;
 *   - exactly one step_run is written per job (never many steps in one job);
 *   - the run context accumulates each step's output;
 *   - a run executes its *pinned* version, not the currently-active one;
 *   - a failing step marks the step run and the run `failed`, enqueues no next
 *     job, and never marks the queue job `done`;
 *   - a redelivered job for an already-advanced run does no work (idempotency);
 *   - the engine never touches another tenant's run.
 *
 * The suite refuses any database whose name lacks "test" and wipes execution
 * tables between tests.
 */

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { parseEnv } from '@/config/env.js';
import type { DatabaseHandle } from '@/db/client.js';
import { events, jobs, tenants, workflowRuns, workflowStepRuns } from '@/db/schema.js';
import { PermanentError } from '@/domain/errors.js';
import type { ClaimedJob } from '@/domain/queue.js';
import { StepHandlerRegistry, defaultStepHandlerRegistry } from '@/domain/step-handler.js';
import { createLogger } from '@/observability/logger.js';
import { WorkflowExecutor } from '@/repositories/execution-engine.js';
import { PostgresJobQueue } from '@/repositories/job-queue.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import { WebhookRepository } from '@/repositories/webhook-repository.js';
import { WorkflowRepository } from '@/repositories/workflow-repository.js';
import { StepFailedError } from '@/worker/dispatcher.js';

import { TEST_DATABASE_URL, createTestDatabaseHandle } from './support.js';

const steps = (...keys: string[]) => keys.map((key) => ({ key, type: 'noop', config: {} }));
const definition = (...keys: string[]) => ({ version: 1, steps: steps(...keys) });

const silent = () =>
  createLogger(parseEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db', LOG_LEVEL: 'silent' }) as never, {
    service: 'test',
  });

describe.skipIf(TEST_DATABASE_URL === undefined)('workflow execution engine integration', () => {
  let handle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;

  // The worker's cross-tenant view of the queue, used to claim/settle jobs.
  const queue = () => new PostgresJobQueue(handle.db);

  const executorWith = (registry: StepHandlerRegistry) =>
    new WorkflowExecutor({ db: handle.db, queue: new PostgresJobQueue(handle.db), registry, logger: silent() });

  const runById = async (runId: string) => {
    const [row] = await handle.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    return row;
  };

  const stepRunsFor = async (runId: string) =>
    handle.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.runId, runId));

  const pendingJobsFor = async (runId: string) =>
    handle.db.select().from(jobs).where(and(eq(jobs.runId, runId), eq(jobs.status, 'pending')));

  /**
   * Author an active workflow with the given noop steps and ingest one event,
   * producing a queued run pinned to that version plus its first job. Returns the
   * run and the created workflow/version ids.
   */
  const seed = async (
    tenantId: string,
    source: string,
    ...stepKeys: string[]
  ): Promise<{ runId: string; workflowId: string; versionId: string }> => {
    const workflows = new WorkflowRepository(new TenantScope(handle.db, tenantId));
    const created = await workflows.create({
      name: `wf-${source}`,
      definition: definition(...stepKeys),
      triggerType: 'webhook',
      triggerConfig: { source },
    });
    const ingestor = new WebhookRepository(new TenantScope(handle.db, tenantId), new PostgresJobQueue(handle.db));
    const result = await ingestor.ingest({ source, dedupeKey: `seed-${source}`, payload: { hello: 'world' } });
    return { runId: result.runId as string, workflowId: created.workflow.id, versionId: created.version.id };
  };

  /**
   * Mirror the worker's settlement for exactly one job: claim, dispatch, then
   * complete on success or fail on a StepFailedError. Returns how it settled.
   */
  const processOne = async (executor: WorkflowExecutor): Promise<'done' | 'failed' | 'empty'> => {
    const job = await queue().claim('worker-test');
    if (job === null) return 'empty';
    try {
      await executor.dispatch(job);
      await queue().complete(job.id);
      return 'done';
    } catch (error) {
      if (error instanceof StepFailedError) {
        await queue().fail(job.id, error.reason);
        return 'failed';
      }
      throw error;
    }
  };

  const throwingRegistry = (): StepHandlerRegistry => {
    const registry = new StepHandlerRegistry();
    registry.register('noop', {
      execute: () => Promise.reject(new PermanentError('step_blew_up', 'deliberate handler failure')),
    });
    return registry;
  };

  beforeAll(async () => {
    handle = createTestDatabaseHandle();
    await handle.verifyConnection();

    const inserted = await handle.db
      .insert(tenants)
      .values([{ name: 'Exec Tenant A' }, { name: 'Exec Tenant B' }])
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

  // Each test starts from an empty execution world (tenants persist). Deleted in
  // FK-dependency order: step runs and jobs, then runs, then versions/workflows,
  // then the events that anchored them.
  beforeEach(async () => {
    await handle.db.delete(workflowStepRuns);
    await handle.db.delete(jobs);
    await handle.db.delete(workflowRuns);
    await handle.db.delete(events);
  });

  describe('linear noop workflows run to completion, one step per job', () => {
    it('a single-step run succeeds in one job with exactly one step run', async () => {
      const { runId } = await seed(tenantA, 'one', 'first');

      await expect(processOne(executorWith(defaultStepHandlerRegistry()))).resolves.toBe('done');

      const run = await runById(runId);
      expect(run!.status).toBe('succeeded');
      expect(run!.currentStepKey).toBeNull();
      expect(run!.finishedAt).toBeInstanceOf(Date);

      const stepRuns = await stepRunsFor(runId);
      expect(stepRuns).toHaveLength(1);
      expect(stepRuns[0]!.stepKey).toBe('first');
      expect(stepRuns[0]!.status).toBe('succeeded');
      expect(stepRuns[0]!.output).toEqual({ ok: true });

      // No further work: the run is done and nothing else was enqueued.
      expect(await pendingJobsFor(runId)).toHaveLength(0);
    });

    it('a three-step run takes exactly three jobs, one step each, accumulating context', async () => {
      const { runId } = await seed(tenantA, 'three', 'a', 'b', 'c');
      const executor = executorWith(defaultStepHandlerRegistry());

      // Job 1 → step a. The run advances to b and enqueues exactly one next job.
      expect(await processOne(executor)).toBe('done');
      let run = await runById(runId);
      expect(run!.status).toBe('running');
      expect(run!.currentStepKey).toBe('b');
      expect(await stepRunsFor(runId)).toHaveLength(1);
      expect(await pendingJobsFor(runId)).toHaveLength(1);

      // Job 2 → step b.
      expect(await processOne(executor)).toBe('done');
      run = await runById(runId);
      expect(run!.currentStepKey).toBe('c');
      expect(await stepRunsFor(runId)).toHaveLength(2);

      // Job 3 → step c, the last. The run finishes and enqueues nothing.
      expect(await processOne(executor)).toBe('done');
      run = await runById(runId);
      expect(run!.status).toBe('succeeded');
      expect(await pendingJobsFor(runId)).toHaveLength(0);

      // The queue is now empty — never more than one job per step existed.
      expect(await processOne(executor)).toBe('empty');

      // Context accumulated one entry per step, each the noop's deterministic output.
      const context = run!.context as { steps: Record<string, { output: unknown }> };
      expect(Object.keys(context.steps).sort()).toEqual(['a', 'b', 'c']);
      expect(context.steps.a!.output).toEqual({ ok: true });
      expect(context.steps.c!.output).toEqual({ ok: true });

      const stepRuns = await stepRunsFor(runId);
      expect(stepRuns.every((s) => s.status === 'succeeded')).toBe(true);
      expect(stepRuns.map((s) => s.stepKey).sort()).toEqual(['a', 'b', 'c']);
    });
  });

  describe('version pinning', () => {
    it('executes the version pinned at run creation, not the currently-active one', async () => {
      // v1 is active with step 'first'; the run pins v1.
      const { runId, workflowId } = await seed(tenantA, 'pinned', 'first');

      // Promote a v2 whose steps differ entirely. The active version is now v2,
      // but the already-created run must keep running v1.
      const workflows = new WorkflowRepository(new TenantScope(handle.db, tenantA));
      await workflows.createVersion(workflowId, {
        definition: definition('changed'),
        triggerType: 'webhook',
        triggerConfig: { source: 'pinned' },
        activate: true,
      });

      // If the engine wrongly re-resolved "active", it would look for step 'first'
      // in v2 (which only has 'changed') and fail. Success proves it ran v1.
      expect(await processOne(executorWith(defaultStepHandlerRegistry()))).toBe('done');

      const run = await runById(runId);
      expect(run!.status).toBe('succeeded');
      const stepRuns = await stepRunsFor(runId);
      expect(stepRuns).toHaveLength(1);
      expect(stepRuns[0]!.stepKey).toBe('first');
    });
  });

  describe('failure behaviour (no retries — that is Step 11)', () => {
    it('marks the step run and the run failed, enqueues no next job, never completes the queue job', async () => {
      const { runId } = await seed(tenantA, 'fail', 'first', 'second');

      // A registry whose noop handler throws deterministically.
      expect(await processOne(executorWith(throwingRegistry()))).toBe('failed');

      const run = await runById(runId);
      expect(run!.status).toBe('failed');
      // current_step_key is preserved so the failing step stays visible.
      expect(run!.currentStepKey).toBe('first');
      expect(run!.error).toMatchObject({ code: 'step_blew_up' });

      const stepRuns = await stepRunsFor(runId);
      expect(stepRuns).toHaveLength(1);
      expect(stepRuns[0]!.status).toBe('failed');
      expect(stepRuns[0]!.error).toMatchObject({ code: 'step_blew_up' });

      // The second step's job was never enqueued: a failed run does not advance.
      expect(await pendingJobsFor(runId)).toHaveLength(0);

      // The queue job was failed, not completed.
      const [job] = await handle.db.select().from(jobs).where(eq(jobs.runId, runId));
      expect(job!.status).toBe('failed');
    });
  });

  describe('idempotency under at-least-once redelivery', () => {
    it('a redelivered job for an already-advanced run does no work', async () => {
      const { runId } = await seed(tenantA, 'redeliver', 'first', 'second');
      const executor = executorWith(defaultStepHandlerRegistry());

      // First delivery advances the run past 'first' and enqueues 'second'.
      expect(await processOne(executor)).toBe('done');
      expect((await runById(runId))!.currentStepKey).toBe('second');
      expect(await stepRunsFor(runId)).toHaveLength(1);
      expect(await pendingJobsFor(runId)).toHaveLength(1);

      // A duplicate delivery of the *first* step's job arrives (its queue
      // completion was lost). The engine sees the run has moved on and does
      // nothing — no throw, no second step run, no extra job.
      const redelivered: ClaimedJob = {
        id: 'redelivered-first',
        tenantId: tenantA,
        runId,
        stepKey: 'first',
        attempt: 0,
        maxAttempts: 5,
        lockedBy: 'worker-test',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      };
      await expect(executor.dispatch(redelivered)).resolves.toBeUndefined();

      expect(await stepRunsFor(runId)).toHaveLength(1);
      expect(await pendingJobsFor(runId)).toHaveLength(1);
    });

    it('a job for a terminal run is a no-op', async () => {
      const { runId } = await seed(tenantA, 'terminal', 'first');
      const executor = executorWith(defaultStepHandlerRegistry());

      expect(await processOne(executor)).toBe('done');
      expect((await runById(runId))!.status).toBe('succeeded');

      const redelivered: ClaimedJob = {
        id: 'redelivered-terminal',
        tenantId: tenantA,
        runId,
        stepKey: 'first',
        attempt: 0,
        maxAttempts: 5,
        lockedBy: 'worker-test',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      };
      await expect(executor.dispatch(redelivered)).resolves.toBeUndefined();

      // Still exactly one step run; the terminal run was not touched again.
      expect(await stepRunsFor(runId)).toHaveLength(1);
    });
  });

  describe('tenant isolation', () => {
    it('advancing one tenant’s run never touches another tenant’s run', async () => {
      const a = await seed(tenantA, 'iso-a', 'first');
      const b = await seed(tenantB, 'iso-b', 'first');
      const executor = executorWith(defaultStepHandlerRegistry());

      // Claim and advance only tenant A's job, via a tenant-scoped queue.
      const scopedA = new PostgresJobQueue(handle.db, { tenantId: tenantA });
      const job = await scopedA.claim('worker-a');
      expect(job).not.toBeNull();
      expect(job!.tenantId).toBe(tenantA);
      await executor.dispatch(job!);
      await scopedA.complete(job!.id);

      // A ran to completion.
      expect((await runById(a.runId))!.status).toBe('succeeded');
      expect(await stepRunsFor(a.runId)).toHaveLength(1);

      // B is entirely untouched: still queued, no step runs, its first job pending.
      const runB = await runById(b.runId);
      expect(runB!.status).toBe('queued');
      expect(runB!.currentStepKey).toBe('first');
      expect(await stepRunsFor(b.runId)).toHaveLength(0);
      expect(await pendingJobsFor(b.runId)).toHaveLength(1);
    });
  });
});
