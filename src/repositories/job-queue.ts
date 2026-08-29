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
 * The class is optionally bound to a tenant. Unbound (the worker's view) it
 * claims and reaps across all tenants — a worker is shared infrastructure.
 * Bound to a tenant it adds a `tenant_id` predicate to every statement, which
 * is what makes "tenant A cannot claim or mutate tenant B's jobs" a provable
 * property rather than a convention.
 */

import { and, asc, eq, lt, lte, sql } from 'drizzle-orm';

import type { AppDatabase, Executor } from '@/db/client.js';
import { jobs } from '@/db/schema.js';
import { InvalidJobTransitionError } from '@/domain/queue.js';
import type { ClaimedJob, EnqueueInput, JobError, Queue } from '@/domain/queue.js';

/** Producers that enqueue inside an already-open transaction depend on this. */
export interface TransactionalJobEnqueuer {
  enqueue(input: EnqueueInput, executor?: Executor): Promise<{ readonly id: string }>;
}

/** The initial lease granted on claim: long enough to run a step, short enough to reclaim promptly. */
export const DEFAULT_LEASE_MS = 5 * 60 * 1_000;

export interface PostgresJobQueueOptions {
  /** How long a claim's lease lasts. Defaults to five minutes. */
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
        maxAttempts: claimed.maxAttempts,
        lockedBy: workerId,
        leaseExpiresAt,
      };
    });
  }

  async complete(jobId: string): Promise<void> {
    const updated = await this.db
      .update(jobs)
      .set({ status: 'done', lockedBy: null, leaseExpiresAt: null })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running'), ...this.tenantScoped()))
      .returning({ id: jobs.id });

    if (updated.length === 0) throw new InvalidJobTransitionError(jobId, 'completed');
  }

  async fail(jobId: string, error: JobError): Promise<void> {
    const updated = await this.db
      .update(jobs)
      .set({ status: 'failed', lastError: error, lockedBy: null, leaseExpiresAt: null })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running'), ...this.tenantScoped()))
      .returning({ id: jobs.id });

    if (updated.length === 0) throw new InvalidJobTransitionError(jobId, 'failed');
  }

  async requeueExpired(): Promise<number> {
    const now = this.now();

    // A single UPDATE … WHERE is atomic and self-serialising: two reapers
    // running it concurrently take row locks in turn, and whichever commits
    // second matches nothing (the rows are no longer `running`), so no job is
    // requeued — or its attempt incremented — twice.
    const requeued = await this.db
      .update(jobs)
      .set({
        status: 'pending',
        lockedBy: null,
        leaseExpiresAt: null,
        attempt: sql`${jobs.attempt} + 1`,
        runAt: now,
      })
      .where(
        and(
          eq(jobs.status, 'running'),
          lt(jobs.leaseExpiresAt, now),
          ...this.tenantScoped(),
        ),
      )
      .returning({ id: jobs.id });

    return requeued.length;
  }
}
