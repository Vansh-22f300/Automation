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
 * Deliberately small: enqueue / claim / complete / fail / retry / release /
 * requeueExpired. That is the whole surface the MVP needs. Heartbeats,
 * priorities, delayed-retry scheduling and a real retry policy are later steps
 * and are intentionally absent — adding them now would be guessing at shapes we
 * do not yet have to commit to.
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
  /**
   * The attempt number this claim represents (0 for a job's first execution).
   * Incremented only when the reaper recovers an abandoned lease — never by a
   * business retry — and bounded by `MAX_CRASH_ATTEMPTS`.
   */
  readonly attempt: number;
  /**
   * How many business retries this job has already consumed (0 before its first
   * retryable failure). Compared against `maxAttempts` to decide whether budget
   * remains. Distinct from `attempt`, which counts lease/crash recovery.
   */
  readonly retryCount: number;
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
 * How many times a job may be recovered from an abandoned lease before the queue
 * gives up on it.
 *
 * A worker that crashes mid-step leaves its job `running` under a lease nobody
 * will renew, and the reaper returns it to `pending`. That safety net is also a
 * loop: a job that *causes* the crash — an OOM on a pathological payload, a
 * segfaulting native dependency, a step that wedges the process — is handed back
 * to the next worker, which dies the same way, forever. The ceiling turns that
 * loop into a terminal state after a bounded number of recoveries, so a poison
 * job costs a finite amount of work instead of pinning a worker indefinitely.
 *
 * Five is deliberately generous: real crash recovery is rare, and a genuine
 * infrastructure incident (a rolling deploy, a node eviction, an OOM caused by a
 * *neighbouring* job) should not be enough to condemn work that would otherwise
 * succeed. It is compared against `attempt`, never `retry_count`.
 */
export const MAX_CRASH_ATTEMPTS = 5;

/**
 * A job the reaper refused to requeue because its crash-recovery budget was
 * exhausted. Carries exactly the identifiers an operator needs to find it —
 * never a payload, a credential or a step's output.
 */
export interface DeadLetteredJob {
  readonly id: string;
  readonly tenantId: string;
  readonly runId: string;
  readonly stepKey: string;
  /** The recoveries this job had already consumed, i.e. at or above the ceiling. */
  readonly attempt: number;
}

/** The outcome of one reaper sweep. */
export interface ReapResult {
  /** How many expired jobs were returned to `pending` (budget remained). */
  readonly requeued: number;
  /** The expired jobs moved to `failed` instead, because the budget was spent. */
  readonly deadLettered: readonly DeadLetteredJob[];
}

/**
 * What a graceful-shutdown lease release attempted to do.
 *
 * `released` means the worker still owned the running lease and voluntarily
 * returned it to `pending`. `not_running` / `not_owned` are safe no-ops: by the
 * time shutdown tried to release, the row had already settled or another worker
 * owned the lease.
 */
export type ReleaseResult =
  | { readonly outcome: 'released' }
  | { readonly outcome: 'not_running'; readonly status: string | null }
  | { readonly outcome: 'not_owned'; readonly lockedBy: string | null };

/**
 * The durable work queue.
 *
 * `claim`, `complete`, `fail`, `retry`, `release` and `requeueExpired` are
 * worker-side operations; `enqueue` produces work. Every worker-side settlement
 * names the worker that holds the lease, so the queue can refuse one from a worker
 * that has since been superseded. The concrete PostgreSQL queue additionally lets a
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

  /**
   * Move a `running` job to `done`, but only if `workerId` still owns its lease.
   * Rejects if the job is not `running` or its lease belongs to someone else.
   */
  complete(jobId: string, workerId: string): Promise<void>;

  /**
   * Move a `running` job to `failed`, recording `error`. Rejects if the job is not
   * `running` or its lease belongs to someone else. Terminal: a failed job is not
   * re-claimed automatically.
   */
  fail(jobId: string, workerId: string, error: JobError): Promise<void>;

  /**
   * Move a `running` job back to `pending` for a *business* retry: record
   * `error`, defer the job until `runAt`, increment `retry_count`, and clear the
   * lease. Rejects if the job is not `running` or its lease belongs to someone
   * else. This is how a retryable step failure with remaining budget is scheduled
   * durably — the deferral lives on the row, enforced by `claim`'s
   * `run_at <= now()` predicate, so a crash during the wait loses nothing. Does
   * NOT touch `attempt` (crash recovery is the reaper's counter, not this one).
   */
  retry(jobId: string, workerId: string, error: JobError, runAt: Date): Promise<void>;

  /**
   * Voluntarily release a `running` job's lease during graceful shutdown,
   * returning it to `pending` without consuming any crash-recovery or business
   * retry budget: `attempt`, `retry_count`, `last_error` and `run_at` are all left
   * exactly as they were. This is not a retry — it says only "this worker has
   * stopped owning this lease".
   *
   * Safe and idempotent: if the row is no longer `running`, or is now leased by
   * another worker, nothing is overwritten and the outcome says which it was.
   */
  release(jobId: string, workerId: string): Promise<ReleaseResult>;

  /**
   * Sweep expired leases. Every `running` job whose lease has lapsed is either
   *
   *   - returned to `pending` with its lock cleared and the lost attempt counted
   *     (`attempt + 1`), while crash-recovery budget remains; or
   *   - moved to `failed` with a `crash_attempts_exhausted` error once `attempt`
   *     has reached `MAX_CRASH_ATTEMPTS`, and never offered to a worker again.
   *
   * Dead-lettering settles the *job* only. The run is left exactly as it was, so
   * it stays inspectable and whoever owns run state decides what a stuck run
   * means; the reaper claims no authority over it.
   *
   * Safe to run from several processes at once. Returns what the sweep did.
   */
  requeueExpired(): Promise<ReapResult>;
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
