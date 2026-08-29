/**
 * The queue, as the rest of the system is allowed to see it.
 *
 * This is a domain contract, not an implementation. It says nothing about
 * PostgreSQL, `FOR UPDATE SKIP LOCKED`, leases-as-timestamps, or transactions —
 * those are the concrete queue's business (see
 * `@/repositories/job-queue`). The worker and the ingestion path depend on this
 * interface so that the storage engine behind the queue can change (a broker, a
 * different table design) without either of them noticing.
 *
 * Deliberately small: enqueue / claim / complete / fail / requeueExpired. That
 * is the whole surface the MVP needs. Heartbeats, priorities, delayed-retry
 * scheduling and a real retry policy are later steps and are intentionally
 * absent — adding them now would be guessing at shapes we do not yet have to
 * commit to.
 */

/**
 * A job as the worker receives it once claimed: enough to execute the step and
 * to correlate every log line, and nothing the worker has no business mutating
 * directly (status transitions go through the queue methods).
 */
export interface ClaimedJob {
  readonly id: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly stepKey: string;
  /** The attempt number this claim represents (0 for a job's first execution). */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** The worker instance that now holds the lease — this worker. */
  readonly lockedBy: string;
  /** When this claim's lease expires; the reaper reclaims the job after it. */
  readonly leaseExpiresAt: Date;
}

/** What creating a job requires. Defaults (attempt, max_attempts, run_at) are the queue's. */
export interface EnqueueInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly stepKey: string;
  /** Overrides the default ceiling. */
  readonly maxAttempts?: number;
  /** Defer the job until this instant. Defaults to now (immediately claimable). */
  readonly runAt?: Date;
}

/** A structured, log-safe failure reason persisted on a failed job. */
export type JobError = Record<string, unknown>;

/**
 * The durable work queue.
 *
 * `claim`, `complete`, `fail` and `requeueExpired` are worker-side operations;
 * `enqueue` produces work. The concrete PostgreSQL queue additionally lets a
 * producer enqueue inside an existing transaction (see `TransactionalJobEnqueuer`
 * in `@/repositories/job-queue`), so webhook ingestion can make the first job
 * part of the same atomic write as the event and the run — a storage detail this
 * abstract contract deliberately does not mention.
 */
export interface Queue {
  /** Create a `pending` job, ready to be claimed at (or after) its `run_at`. */
  enqueue(input: EnqueueInput): Promise<{ readonly id: string }>;

  /**
   * Atomically take the oldest ready `pending` job for `workerId`, moving it to
   * `running` under a fresh lease. Returns null when nothing is ready. Two
   * workers calling this concurrently never receive the same job.
   */
  claim(workerId: string): Promise<ClaimedJob | null>;

  /** Move a `running` job to `done`. Rejects if the job is not `running`. */
  complete(jobId: string): Promise<void>;

  /**
   * Move a `running` job to `failed`, recording `error`. Rejects if the job is
   * not `running`. Terminal: a failed job is not re-claimed automatically.
   */
  fail(jobId: string, error: JobError): Promise<void>;

  /**
   * Return every `running` job whose lease has expired to `pending`, clearing
   * its lock and counting the lost attempt. Safe to run from several processes
   * at once. Returns how many jobs were reclaimed.
   */
  requeueExpired(): Promise<number>;
}

/**
 * Raised when a queue method is asked for a transition the state machine
 * forbids — completing a job that is not `running`, failing one that already
 * settled, and so on. Distinct from an infrastructure error: it means the
 * caller's view of the job is stale, not that the database is unreachable.
 */
export class InvalidJobTransitionError extends Error {
  readonly code = 'invalid_job_transition';
  readonly jobId: string;

  constructor(jobId: string, attempted: string) {
    super(`job ${jobId} could not be ${attempted}: it is not in the required state`);
    this.name = 'InvalidJobTransitionError';
    this.jobId = jobId;
    Error.captureStackTrace(this, InvalidJobTransitionError);
  }
}
