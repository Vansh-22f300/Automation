/**
 * The workflow execution engine — the real `StepDispatcher`.
 *
 * This is where a claimed job becomes actual workflow progress. The contract is
 * narrow and load-bearing: **one job advances one run by exactly one step.** The
 * engine never loads or runs a whole workflow; it executes the single step the
 * job names, records the result, and — if the definition has a next step — enqueues
 * exactly one more job. The worker stays ignorant of all of this; it claims,
 * calls `dispatch`, and settles the queue job by the outcome.
 *
 * Safe run advancement under redelivery has two independent layers:
 *
 *   1. The runtime guard — a `SELECT … FOR UPDATE` on the run plus a check that
 *      the run has not already advanced past this step. A redelivered job for an
 *      already-advanced (or finished) run does no work and is simply completed.
 *
 *   2. The database backstop — the partial unique index on `workflow_step_runs`
 *      (one success per run+step+attempt). A second `succeeded` row for the same
 *      (run, step, attempt) violates the index and aborts the transaction.
 *
 * Version pinning is absolute: the engine executes `run.workflow_version_id`,
 * never "the current active version". Tenant isolation is a predicate on every
 * statement, reinforced by the composite foreign keys.
 *
 * --- Two-transaction model ---
 *
 * The handler (Slack/LLm/tool calls) runs OUTSIDE any database transaction. This
 * avoids holding a transaction open for minutes while external APIs respond, and
 * bounds the two DB transactions to short, fast operations:
 *
 *   Transaction A (beginStep):  lock run, run guards, validate version/step,
 *     INSERT a `running` step_run, commit.
 *
 *   Handler (invokeHandler):   execute the step handler with no DB transaction
 *     open. External side effects are at-least-once.
 *
 *   Transaction B (settleStep): lock run, re-check step-supersede guard, settle
 *     step_run (succeeded/failed), persist llm_usage, update run state/context,
 *     enqueue next job — all atomic, then commit.
 *
 * The job lease/reaper remains the SOLE recovery authority. No step-run lease,
 * no step-run reaper, no new recovery authority. An orphaned `running` step_run
 * from a crashed worker is an audit artifact only; a recovered job creates a new
 * physical step_run at the new stepRunAttempt.
 */

import { and, eq } from 'drizzle-orm';

import type { AppDatabase, Transaction } from '@/db/client.js';
import { workflowRuns, workflowStepRuns, workflowVersions, llmUsage } from '@/db/schema.js';
import type { WorkflowRun } from '@/db/schema.js';
import { isAppError } from '@/domain/errors.js';
import { ExecutionContext } from '@/domain/execution-context.js';
import type { JobError, ClaimedJob } from '@/domain/queue.js';
import { resolveInput } from '@/domain/references.js';
import { assertRunTransition } from '@/domain/run-state.js';
import type { RunStatus } from '@/domain/run-state.js';
import { createRetryPolicy } from '@/domain/retry-policy.js';
import type { RetryPolicy } from '@/domain/retry-policy.js';
import { DEFAULT_LEASE_MS } from '@/domain/timing.js';
import type { StepUsage } from '@/domain/step-handler.js';
import type { StepHandlerRegistry } from '@/domain/step-handler.js';
import { parseWorkflowDefinition } from '@/domain/workflow-definition.js';
import type { WorkflowDefinition, WorkflowStep } from '@/domain/workflow-definition.js';
import type { RunContext } from '@/domain/workflow-run.js';
import type { TransactionalJobEnqueuer } from '@/repositories/job-queue.js';
import { withContext } from '@/observability/logger.js';
import type { Logger } from '@/observability/logger.js';
import { StepFailedError, StepRetryError } from '@/worker/dispatcher.js';
import type { StepDispatcher } from '@/worker/dispatcher.js';

export interface WorkflowExecutorOptions {
  readonly db: AppDatabase;
  /** Used to create the *next* step's job inside the same transaction. */
  readonly queue: TransactionalJobEnqueuer;
  readonly registry: StepHandlerRegistry;
  readonly logger: Logger;
  /**
   * The business retry policy — how long to defer a retryable failure. Injectable
   * so tests can pin the jittered delay; defaults to the production curve.
   */
  readonly retryPolicy?: RetryPolicy;
  /** The clock used to compute a retry's `run_at`. Injectable for deterministic tests. */
  readonly now?: () => Date;
}

/** The result of processing one job, deciding how the worker settles the queue. */
type Outcome =
  | { readonly settle: 'complete'; readonly detail: string }
  | { readonly settle: 'fail'; readonly reason: JobError }
  | { readonly settle: 'retry'; readonly reason: JobError; readonly runAt: Date };

/**
 * What the handler returns to Transaction B. On success, carries the output and
 * optional LLM usage. On failure, carries the structured reason — settleStep
 * decides fail vs. retry and records the failed step_run.
 */
interface StepResult {
  readonly output: unknown;
  readonly usage?: readonly StepUsage[];
  readonly error?: JobError;
}

/**
 * What Transaction A (beginStep) hands to the handler and Transaction B
 * (settleStep). Carries everything needed to invoke the handler and then settle
 * its result — no re-querying, no re-validation.
 */
interface BegunStep {
  readonly stepRunId: string;
  readonly step: WorkflowStep;
  readonly stepIndex: number;
  readonly definition: WorkflowDefinition;
  readonly context: ExecutionContext;
  readonly input: Record<string, unknown>;
  readonly startedAt: Date;
  readonly log: Logger;
}

/** Reduce any thrown value to a structured, log-safe failure reason. No stacks. */
function toJobError(error: unknown): JobError {
  if (isAppError(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  return {
    code: 'step_execution_error',
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Read an explicit reschedule hint (`retryAfterMs`) off a failure reason's
 * `details`, if present and well-formed. This is the sole channel by which the
 * effect ledger's live-reservation defer reaches the retry scheduler: the ledger
 * throws a `RetryableError` carrying `details.retryAfterMs`, `toJobError` preserves
 * `details` verbatim, and the reason is a plain `JobError` (`Record<string,
 * unknown>`) by the time it is settled — so the field arrives as `unknown` and must
 * be narrowed here. Absent or malformed → undefined, and scheduling falls back to
 * the backoff curve.
 */
function readRetryAfterMs(reason: JobError): number | undefined {
  const details = reason['details'];
  if (typeof details !== 'object' || details === null) return undefined;
  const hint = (details as Record<string, unknown>)['retryAfterMs'];
  return typeof hint === 'number' && Number.isFinite(hint) && hint >= 0 ? hint : undefined;
}

export class WorkflowExecutor implements StepDispatcher {
  private readonly db: AppDatabase;
  private readonly queue: TransactionalJobEnqueuer;
  private readonly registry: StepHandlerRegistry;
  private readonly logger: Logger;
  private readonly retryPolicy: RetryPolicy;
  private readonly now: () => Date;

  constructor(options: WorkflowExecutorOptions) {
    this.db = options.db;
    this.queue = options.queue;
    this.registry = options.registry;
    this.logger = options.logger;
    this.retryPolicy = options.retryPolicy ?? createRetryPolicy();
    this.now = options.now ?? (() => new Date());
  }

  async dispatch(job: ClaimedJob): Promise<void> {
    // Transaction A: lock run, run guards, validate version/step, INSERT a
    // `running` step_run, commit. Returns null when the job is a safe no-op
    // (run already terminal, or this step already superseded) — complete it.
    const begun = await this.beginStep(job);
    if (begun === null) return;

    // Handler: execute the step with NO database transaction open. External side
    // effects (Slack, LLM) happen here and are at-least-once.
    const result = await this.invokeHandler(begun, job);

    // Transaction B: lock run, re-check step-supersede guard, settle step_run,
    // persist llm_usage, update run state/context, enqueue next job — all atomic.
    const outcome = await this.settleStep(begun, result, job);

    if (outcome.settle === 'fail') {
      throw new StepFailedError(outcome.reason);
    }
    if (outcome.settle === 'retry') {
      throw new StepRetryError(outcome.reason, outcome.runAt);
    }
    // 'complete': the worker marks the job done. Nothing more to do here.
  }

  /**
   * Transaction A: lock the run, apply the runtime guards, validate the pinned
   * version and step, resolve input, and INSERT a `running` step_run — then commit.
   *
   * Returns a `BegunStep` carrying everything the handler and Transaction B need,
   * so they never re-query or re-validate. An unresolved reference or a missing
   * version/step is a deterministic failure: the run is marked failed and the
   * method returns `null` (the caller translates that into a `fail` outcome).
   */
  private async beginStep(job: ClaimedJob): Promise<BegunStep | null> {
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(workflowRuns)
        .where(and(eq(workflowRuns.tenantId, job.tenantId), eq(workflowRuns.id, job.runId)))
        .for('update');

      if (run === undefined) {
        // The worker already checks existence, but a run could vanish between claim
        // and dispatch. Deterministic: fail the job, do not leave it for the reaper.
        return null;
      }

      const log = withContext(this.logger, { tenant_id: job.tenantId, run_id: job.runId }).child({
        job_id: job.id,
        step_key: job.stepKey,
        attempt: job.attempt,
        retry_count: job.retryCount,
        worker_id: job.lockedBy,
      });

      const runStatus = run.status as RunStatus;

      // Guard 1: the run has already finished. A redelivered job for a terminal
      // run does no work — its outcome is already sealed and recorded.
      if (runStatus === 'succeeded' || runStatus === 'failed' || runStatus === 'cancelled') {
        log.info({ run_status: runStatus }, 'job_skipped_run_terminal');
        return null;
      }

      // Guard 2: the run has advanced past this step (a prior attempt committed
      // and enqueued the next job, but its queue completion was lost).
      // Re-executing would double-advance; instead, complete this stale job.
      if (run.currentStepKey !== job.stepKey) {
        log.info({ current_step_key: run.currentStepKey }, 'job_skipped_step_superseded');
        return null;
      }

      // Version pinning: execute the exact version the run pinned at creation.
      const [version] = await tx
        .select({ definition: workflowVersions.definition })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.tenantId, job.tenantId),
            eq(workflowVersions.id, run.workflowVersionId),
          ),
        );

      if (version === undefined) {
        const reason = { code: 'run_version_not_found', message: 'pinned workflow version is missing' };
        await this.markRunFailed(tx, job, run, run.context as unknown as RunContext, reason);
        log.error(reason, 'run_failed');
        return null;
      }

      const definition = parseWorkflowDefinition(version.definition);
      const stepIndex = definition.steps.findIndex((s) => s.key === job.stepKey);
      if (stepIndex < 0) {
        const reason = {
          code: 'step_not_in_definition',
          message: `step "${job.stepKey}" is not part of the pinned definition`,
        };
        await this.markRunFailed(tx, job, run, run.context as unknown as RunContext, reason);
        log.error(reason, 'run_failed');
        return null;
      }

      const step = definition.steps[stepIndex]!;
      assertRunTransition(runStatus, 'running');

      const stepRunAttempt = job.attempt + job.retryCount;
      const context = new ExecutionContext(run.context as unknown as RunContext);
      const startedAt = new Date();

      // Resolve references before recording as running — an unresolved reference
      // is a clean, deterministic failure.
      let input: Record<string, unknown>;
      try {
        input = resolveInput(step.config, context) as Record<string, unknown>;
      } catch (error) {
        const reason = toJobError(error);
        await tx.insert(workflowStepRuns).values({
          tenantId: job.tenantId,
          runId: job.runId,
          stepKey: step.key,
          stepType: step.type,
          attempt: stepRunAttempt,
          status: 'failed',
          error: reason,
          startedAt,
          finishedAt: new Date(),
          durationMs: 0,
        });
        await this.markRunFailed(tx, job, run, context.snapshot(), reason);
        log.warn({ reason: reason.code }, 'step_failed');
        log.error({ reason: reason.code }, 'run_failed');
        return null;
      }

      const [stepRun] = await tx
        .insert(workflowStepRuns)
        .values({
          tenantId: job.tenantId,
          runId: job.runId,
          stepKey: step.key,
          stepType: step.type,
          attempt: stepRunAttempt,
          status: 'running',
          input,
          startedAt,
        })
        .returning({ id: workflowStepRuns.id });
      const stepRunId = stepRun!.id;

      log.info({ step_run_id: stepRunId, step_type: step.type }, 'step_started');

      return { stepRunId, step, stepIndex, definition, context, input, startedAt, log };
    });
  }

  /**
   * Invoke the step handler with NO database transaction open. External side
   * effects (Slack, LLM, tool calls) happen here and are at-least-once.
   *
   * A thrown error is caught and translated into a `StepResult` whose `error`
   * carries the structured reason — Transaction B decides fail vs. retry. The
   * handler is never re-invoked for the same `BegunStep`; redelivery creates a
   * fresh attempt via the reaper.
   */
  private async invokeHandler(begun: BegunStep, job: ClaimedJob): Promise<StepResult> {
    const stepLog = begun.log.child({ step_run_id: begun.stepRunId, step_type: begun.step.type });
    try {
      return await this.registry.get(begun.step.type).execute({
        step: begun.step,
        context: begun.context,
        input: begun.input,
        logger: stepLog,
        tenantId: job.tenantId,
        runId: job.runId,
        stepRunId: begun.stepRunId,
      });
    } catch (error) {
      const reason = toJobError(error);
      stepLog.warn({ reason: reason.code }, 'step_handler_failed');
      // Return the failure as a result — settleStep records the failed step_run
      // and decides fail vs. retry. The handler is never re-run for this attempt.
      return { output: null, error: reason };
    }
  }

  /**
   * Transaction B: settle the step run, persist usage, update the run, and enqueue
   * the next job — all atomic, then commit.
   *
   * Re-checks the step-supersede guard after locking: a prior attempt may have
   * committed and enqueued the next job while this handler was running. Re-executing
   * would double-advance; instead, the orphaned `running` row is left as-is (audit
   * artifact) and this job is completed.
   */
  private async settleStep(
    begun: BegunStep,
    result: StepResult,
    job: ClaimedJob,
  ): Promise<Outcome> {
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(workflowRuns)
        .where(and(eq(workflowRuns.tenantId, job.tenantId), eq(workflowRuns.id, job.runId)))
        .for('update');

      if (run === undefined) {
        // The run vanished between Transaction A and Transaction B. Deterministic:
        // fail the job, do not leave it for the reaper.
        return { settle: 'fail', reason: { code: 'run_not_found', message: 'workflow run does not exist' } };
      }

      // Guard: the run has advanced past this step while the handler was running.
      // A prior attempt committed and enqueued the next job. Re-executing would
      // double-advance; complete this stale job. The orphaned `running` row is
      // left as-is for audit.
      if (run.currentStepKey !== job.stepKey) {
        begun.log.info({ current_step_key: run.currentStepKey }, 'job_skipped_step_superseded');
        return { settle: 'complete', detail: 'step_superseded' };
      }

      // Guard: the run has finished while the handler was running (e.g. a
      // concurrent failure path). Complete this stale job.
      const runStatus = run.status as RunStatus;
      if (runStatus === 'succeeded' || runStatus === 'failed' || runStatus === 'cancelled') {
        begun.log.info({ run_status: runStatus }, 'job_skipped_run_terminal');
        return { settle: 'complete', detail: 'run_terminal' };
      }

      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - begun.startedAt.getTime();

      // Handler failed: settle the step run as failed and decide fail vs. retry.
      if (result.error !== undefined) {
        const reason = result.error;
        await tx
          .update(workflowStepRuns)
          .set({ status: 'failed', error: reason, finishedAt, durationMs })
          .where(eq(workflowStepRuns.id, begun.stepRunId));

        if (reason.retryable === true && job.retryCount < job.maxAttempts) {
          // Prefer an explicit reschedule hint from the effect ledger over the
          // backoff curve. The ledger sets `retryAfterMs` only when it deferred this
          // attempt against another attempt's LIVE reservation, and the delay must
          // outlast that reservation's lease — which the backoff budget (~15-31s
          // total) cannot guarantee. Cap it at the job lease so a hint can never
          // push a retry past the point the queue would reclaim the job anyway.
          const hintedMs = readRetryAfterMs(reason);
          const delayMs =
            hintedMs !== undefined ? Math.min(hintedMs, DEFAULT_LEASE_MS) : this.retryPolicy.backoffMs(job.retryCount);
          const runAt = new Date(this.now().getTime() + delayMs);
          begun.log.warn(
            {
              reason: reason.code,
              retry_count: job.retryCount,
              max_attempts: job.maxAttempts,
              delay_ms: Math.round(delayMs),
              ...(hintedMs !== undefined ? { retry_after_hint_ms: Math.round(hintedMs) } : {}),
              next_run_at: runAt.toISOString(),
            },
            'step_retry_scheduled',
          );
          return { settle: 'retry', reason, runAt };
        }

        if (reason.retryable === true) {
          begun.log.warn(
            { reason: reason.code, retry_count: job.retryCount, max_attempts: job.maxAttempts },
            'step_retry_exhausted',
          );
        }

        await this.markRunFailed(tx, job, run, begun.context.snapshot(), reason);
        begun.log.warn({ reason: reason.code }, 'step_failed');
        begun.log.error({ reason: reason.code }, 'run_failed');
        return { settle: 'fail', reason };
      }

      // Handler succeeded: settle the step run and record its output.
      const output = result.output;
      await tx
        .update(workflowStepRuns)
        .set({ status: 'succeeded', output, finishedAt, durationMs })
        .where(eq(workflowStepRuns.id, begun.stepRunId));

      // Persist LLM usage atomically with the step result. One row per provider
      // round, tagged with its 1-based round index.
      if (result.usage !== undefined && result.usage.length > 0) {
        await tx.insert(llmUsage).values(
          result.usage.map((usage, index) => ({
            tenantId: job.tenantId,
            runId: job.runId,
            stepRunId: begun.stepRunId,
            round: index + 1,
            provider: usage.provider,
            model: usage.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            latencyMs: usage.latencyMs,
          })),
        );
      }

      begun.context.setStepOutput(begun.step.key, output);
      begun.log.info('step_succeeded');

      const nextStep = begun.definition.steps[begun.stepIndex + 1];
      if (nextStep !== undefined) {
        // Advance: point the run at the next step, persist the grown context, and
        // enqueue exactly one job for it — atomic with everything above.
        assertRunTransition('running', 'running');
        await tx
          .update(workflowRuns)
          .set({
            status: 'running',
            currentStepKey: nextStep.key,
            startedAt: run.startedAt ?? begun.startedAt,
            context: begun.context.snapshot() as unknown as Record<string, unknown>,
          })
          .where(and(eq(workflowRuns.tenantId, job.tenantId), eq(workflowRuns.id, job.runId)));
        await this.queue.enqueue(
          { tenantId: job.tenantId, runId: job.runId, stepKey: nextStep.key },
          tx,
        );
        begun.log.info({ next_step_key: nextStep.key }, 'run_advanced');
        return { settle: 'complete', detail: 'advanced' };
      }

      // No next step: the run is complete.
      assertRunTransition('running', 'succeeded');
      await tx
        .update(workflowRuns)
        .set({
          status: 'succeeded',
          currentStepKey: null,
          startedAt: run.startedAt ?? begun.startedAt,
          finishedAt,
          context: begun.context.snapshot() as unknown as Record<string, unknown>,
        })
        .where(and(eq(workflowRuns.tenantId, job.tenantId), eq(workflowRuns.id, job.runId)));
      begun.log.info('run_succeeded');
      return { settle: 'complete', detail: 'run_succeeded' };
    });
  }

  /**
   * Mark the run failed, preserving `current_step_key` so the failing step is
   * visible, and storing the structured reason. Validated against the run state
   * machine (queued/running → failed).
   */
  private async markRunFailed(
    tx: Transaction,
    job: ClaimedJob,
    run: WorkflowRun,
    context: RunContext,
    reason: JobError,
  ): Promise<void> {
    assertRunTransition(run.status as RunStatus, 'failed');
    await tx
      .update(workflowRuns)
      .set({
        status: 'failed',
        error: reason as Record<string, unknown>,
        finishedAt: new Date(),
        context: context as unknown as Record<string, unknown>,
      })
      .where(and(eq(workflowRuns.tenantId, job.tenantId), eq(workflowRuns.id, job.runId)));
  }
}
