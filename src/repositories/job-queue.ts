/**
 * The PostgreSQL implementation of the domain `Queue`.
 *
 * Postgres *is* the broker. The claim is the canonical pattern for using a
 * relational table as a concurrent work queue:
 *
 *   SELECT id FROM jobs
 *    WHERE status = 'pending' AND run_at <= now()
 *    ORDER BY run_at
 *    FOR UPDATE SKIP LOCKED
 *    LIMIT 1;
 *
 * `FOR UPDATE` locks the candidate row; `SKIP LOCKED` makes a second worker
 * running the same query step over that locked row and take the next one
 * instead of blocking on it. That single clause is what lets N workers poll the
 * same table and each get distinct jobs with no coordinator. The lock is held
 * only for the length of the claim transaction — which does nothing but flip
 * the row to `running` and stamp the lease — so the (potentially slow) step
 * execution that follows never holds a row lock or a transaction open.
 *
 * State transitions are enforced with the WHERE clause, not with a read-modify-
 * write: `complete`/`fail` only touch a row that is still `running`, and the
 * claim only promotes a row that is still `pending`. An UPDATE that matches no
 * row is how an illegal transition (or a lost race) surfaces, rather than
 * silently succeeding.
 *
 * Recovery is bounded. Handing an abandoned job back to a worker is a safety net,
 * but done unconditionally it is also how one poisonous job crash-loops a fleet
 * forever, so `requeueExpired` dead-letters a job that has already burned its
 * `MAX_CRASH_ATTEMPTS` recoveries instead of offering it again.
 *
 * The class is optionally bound to a tenant. Unbound (the worker's view) it
 * claims and reaps across all tenants — a worker is shared infrastructure.
 * Bound to a tenant it adds a `tenant_id` predicate to every statement, which
 * is what makes "tenant A cannot claim or mutate tenant B's jobs" a provable
 * property rather than a convention.
 */

import { and, asc, eq, gte, lt, lte, sql } from 'drizzle-orm';

import type { AppDatabase, Executor } from '@/db/client.js';
import { jobs } from '@/db/schema.js';
import { InvalidJobTransitionError, MAX_CRASH_ATTEMPTS } from '@/domain/queue.js';
import type {
  ClaimedJob,
  EnqueueInput,
  JobError,
  Queue,
  ReapResult,
  ReleaseResult,
} from '@/domain/queue.js';
import { DEFAULT_LEASE_MS } from '@/domain/timing.js';

/** Producers that enqueue inside an already-open transaction depend on this. */
export interface TransactionalJobEnqueuer {
  enqueue(input: EnqueueInput, executor?: Executor): Promise<{ readonly id: string }>;
}

/**
 * What a dead-lettered job records in `last_error`.
 *
 * Constant, not per-row: the row's own `attempt` column already states how many
 * recoveries it consumed, so nothing is lost by not repeating it here — and a
 * fixed payload keeps the dead-letter UPDATE a single plain statement instead of
 * per-row JSON construction. Contains no payload, no credential and no step
 * output, so it is safe to return from the inspection API and to log.
 */
const CRASH_ATTEMPTS_EXHAUSTED: JobError = {
  code: 'crash_attempts_exhausted',
  message:
    `the lease expired again after ${MAX_CRASH_ATTEMPTS} crash recoveries; ` +
    'the job is dead-lettered instead of being requeued a further time',
  retryable: false,
  details: { crash_attempt_limit: MAX_CRASH_ATTEMPTS },
};

export interface PostgresJobQueueOptions {
  /** How long a claim's lease lasts. Defaults to the centralized safe bound. */
  readonly leaseDurationMs?: number;
  /**
   * The clock. Injectable so tests can advance time deterministically; in
   * production it is the wall clock. `run_at`/`lease_expires_at` comparisons and
   * the lease expiry are all computed from this one source.
   */
  readonly now?: () => Date;
  /** Binds every statement to one tenant. Omit for the worker's cross-tenant view. */
  readonly tenantId?: string;
}

export class PostgresJobQueue implements Queue, TransactionalJobEnqueuer {
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;
  private readonly tenantId: string | undefined;

  constructor(
    private readonly db: AppDatabase,
    options: PostgresJobQueueOptions = {},
  ) {
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_MS;
    this.now = options.now ?? (() => new Date());
    this.tenantId = options.tenantId;
  }

  /** The tenant predicate, present only when this queue is tenant-bound. */
  private tenantScoped(): ReturnType<typeof eq>[] {
    return this.tenantId === undefined ? [] : [eq(jobs.tenantId, this.tenantId)];
  }

  async enqueue(input: EnqueueInput, executor: Executor = this.db): Promise<{ id: string }> {
    if (this.tenantId !== undefined && input.tenantId !== this.tenantId) {
      // A tenant-bound queue cannot enqueue on behalf of another tenant. (The
      // composite FK would also reject a job pointing at another tenant's run,
      // but failing here is clearer and does not depend on the run's existence.)
      throw new Error(
        `tenant-scoped queue for ${this.tenantId} cannot enqueue for tenant ${input.tenantId}`,
      );
    }

    const values = {
      tenantId: input.tenantId,
      runId: input.runId,
      stepKey: input.stepKey,
      status: 'pending' as const,
      attempt: 0,
      ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
      runAt: input.runAt ?? this.now(),
    };

    const [row] = await executor.insert(jobs).values(values).returning({ id: jobs.id });
    return { id: row!.id };
  }

  async claim(workerId: string): Promise<ClaimedJob | null> {
    const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseDurationMs);

    return this.db.transaction(async (tx) => {
      // Lock exactly one ready row, skipping any a peer already holds. The
      // transaction is intentionally tiny: select-and-update, then commit.
      const [candidate] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.status, 'pending'), lte(jobs.runAt, now), ...this.tenantScoped()))
        .orderBy(asc(jobs.runAt))
        .limit(1)
        .for('update', { skipLocked: true });

      if (candidate === undefined) return null;

      // The `status = 'pending'` guard is belt-and-braces given the row lock,
      // and keeps the promotion honest if the query above is ever relaxed.
      const [claimed] = await tx
        .update(jobs)
        .set({ status: 'running', lockedBy: workerId, leaseExpiresAt })
        .where(and(eq(jobs.id, candidate.id), eq(jobs.status, 'pending')))
        .returning();

      if (claimed === undefined) return null;

      return {
        id: claimed.id,
        tenantId: claimed.tenantId,
        runId: claimed.runId,
        stepKey: claimed.stepKey,
        attempt: claimed.attempt,
        retryCount: claimed.retryCount,
        maxAttempts: claimed.maxAttempts,
        lockedBy: workerId,
        leaseExpiresAt,
      };
    });
  }

  async complete(jobId: string, workerId: string): Promise<void> {
    const updated = await this.db
      .update(jobs)
      .set({ status: 'done', lockedBy: null, leaseExpiresAt: null })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, 'running'),
          eq(jobs.lockedBy, workerId),
          ...this.tenantScoped(),
        ),
      )
      .returning({ id: jobs.id });

    if (updated.length === 0) throw new InvalidJobTransitionError(jobId, 'completed');
  }

  async fail(jobId: string, workerId: string, error: JobError): Promise<void> {
    const updated = await this.db
      .update(jobs)
      .set({ status: 'failed', lastError: error, lockedBy: null, leaseExpiresAt: null })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, 'running'),
          eq(jobs.lockedBy, workerId),
          ...this.tenantScoped(),
        ),
      )
      .returning({ id: jobs.id });

    if (updated.length === 0) throw new InvalidJobTransitionError(jobId, 'failed');
  }

  async retry(jobId: string, workerId: string, error: JobError, runAt: Date): Promise<void> {
    // running → pending, deferred until `runAt`, business retry counter bumped,
    // lease cleared. The `status = 'running'` guard makes this a no-op on a lost
    // race (e.g. the reaper requeued the row first): the UPDATE matches nothing
    // and we surface an illegal transition rather than silently double-scheduling.
    // `attempt` is deliberately untouched — that counter belongs to crash
    // recovery, not business retries.
    const updated = await this.db
      .update(jobs)
      .set({
        status: 'pending',
        lastError: error,
        runAt,
        retryCount: sql`${jobs.retryCount} + 1`,
        lockedBy: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.status, 'running'),
          eq(jobs.lockedBy, workerId),
          ...this.tenantScoped(),
        ),
      )
      .returning({ id: jobs.id });

    if (updated.length === 0) throw new InvalidJobTransitionError(jobId, 'retried');
  }

  async release(jobId: string, workerId: string): Promise<ReleaseResult> {
    return this.db.transaction(async (tx) => {
      const [released] = await tx
        .update(jobs)
        .set({
          status: 'pending',
          lockedBy: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.status, 'running'),
            eq(jobs.lockedBy, workerId),
            ...this.tenantScoped(),
          ),
        )
        .returning({ id: jobs.id });

      if (released !== undefined) {
        return { outcome: 'released' };
      }

      const [current] = await tx
        .select({ status: jobs.status, lockedBy: jobs.lockedBy })
        .from(jobs)
        .where(and(eq(jobs.id, jobId), ...this.tenantScoped()))
        .limit(1);

      if (current === undefined || current.status !== 'running') {
        return { outcome: 'not_running', status: current?.status ?? null };
      }

      return { outcome: 'not_owned', lockedBy: current.lockedBy };
    });
  }

  /** Every `running` job whose lease has lapsed, within this queue's tenant view. */
  private expiredLease(now: Date): ReturnType<typeof eq>[] {
    return [eq(jobs.status, 'running'), lt(jobs.leaseExpiresAt, now), ...this.tenantScoped()];
  }

  async requeueExpired(): Promise<ReapResult> {
    const now = this.now();

    // Two UPDATEs, one transaction, disjoint by construction: a row is either at
    // the crash-recovery ceiling or below it, never both, so neither statement can
    // touch a row the other claimed and their order is irrelevant.
    //
    // Each UPDATE … WHERE is atomic and self-serialising, which is what makes
    // concurrent reapers safe: two of them take the row locks in turn, and
    // whichever commits second matches nothing (the rows are no longer `running`),
    // so no job is requeued — or its attempt incremented, or dead-lettered —
    // twice. The transaction adds nothing to that guarantee; it only makes the
    // pair of counts this method returns describe a single point in time.
    return this.db.transaction(async (tx) => {
      // Budget spent: settle the job terminally. `attempt` is deliberately NOT
      // incremented — it counts recoveries actually performed, and this is the
      // refusal to perform one, so `attempt === MAX_CRASH_ATTEMPTS` stays the
      // readable "exhausted" signal (and no attempt number is minted that will
      // never correspond to a step run).
      //
      // Only the job is settled. The run keeps whatever status it had, because
      // run-state authority lives with the execution engine, not the reaper; the
      // failed job is visible on the run either way.
      const deadLettered = await tx
        .update(jobs)
        .set({
          status: 'failed',
          lastError: CRASH_ATTEMPTS_EXHAUSTED,
          lockedBy: null,
          leaseExpiresAt: null,
        })
        .where(and(...this.expiredLease(now), gte(jobs.attempt, MAX_CRASH_ATTEMPTS)))
        .returning({
          id: jobs.id,
          tenantId: jobs.tenantId,
          runId: jobs.runId,
          stepKey: jobs.stepKey,
          attempt: jobs.attempt,
        });

      // Budget remains: recover the job exactly as before, counting the lost
      // attempt. `retry_count` is untouched — a crash is not a business retry.
      const requeued = await tx
        .update(jobs)
        .set({
          status: 'pending',
          lockedBy: null,
          leaseExpiresAt: null,
          attempt: sql`${jobs.attempt} + 1`,
          runAt: now,
        })
        .where(and(...this.expiredLease(now), lt(jobs.attempt, MAX_CRASH_ATTEMPTS)))
        .returning({ id: jobs.id });

      return { requeued: requeued.length, deadLettered };
    });
  }
}
