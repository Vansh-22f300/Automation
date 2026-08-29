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
 * Everything that must not tear apart happens in one transaction: the step-run
 * record, the run's context/status update, and the next job's creation commit
 * together or not at all. There is never "step succeeded but the next job is
 * missing" nor "next job created but the result was not recorded".
 *
 * Idempotency under at-least-once delivery has two layers. The runtime guard is
 * a `SELECT … FOR UPDATE` on the run plus a check that the run has not already
 * advanced past this step — a redelivered job for an already-advanced (or
 * finished) run does no work and is simply completed. The database backstop is
 * the partial unique index on `workflow_step_runs` (one success per run+step+
 * attempt). Version pinning is absolute: the engine executes `run.workflow_version_id`,
 * never "the current active version". Tenant isolation is a predicate on every
 * statement, reinforced by the composite foreign keys.
 */

import { and, eq } from 'drizzle-orm';

import type { AppDatabase, Transaction } from '@/db/client.js';
import { workflowRuns, workflowStepRuns, workflowVersions } from '@/db/schema.js';
import type { WorkflowRun } from '@/db/schema.js';
import { isAppError } from '@/domain/errors.js';
import { ExecutionContext } from '@/domain/execution-context.js';
import type { JobError, ClaimedJob } from '@/domain/queue.js';
import { resolveInput } from '@/domain/references.js';
import { assertRunTransition } from '@/domain/run-state.js';
import type { RunStatus } from '@/domain/run-state.js';
import type { StepHandlerRegistry } from '@/domain/step-handler.js';
import { parseWorkflowDefinition } from '@/domain/workflow-definition.js';
import type { WorkflowDefinition } from '@/domain/workflow-definition.js';
import type { RunContext } from '@/domain/workflow-run.js';
import type { TransactionalJobEnqueuer } from '@/repositories/job-queue.js';
import { withContext } from '@/observability/logger.js';
import type { Logger } from '@/observability/logger.js';
import { StepFailedError } from '@/worker/dispatcher.js';
import type { StepDispatcher } from '@/worker/dispatcher.js';

export interface WorkflowExecutorOptions {
  readonly db: AppDatabase;
  /** Used to create the *next* step's job inside the same transaction. */
  readonly queue: TransactionalJobEnqueuer;
  readonly registry: StepHandlerRegistry;
  readonly logger: Logger;
}

/** The result of processing one job, deciding how the worker settles the queue. */
type Outcome =
  | { readonly settle: 'complete'; readonly detail: string }
  | { readonly settle: 'fail'; readonly reason: JobError };

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

export class WorkflowExecutor implements StepDispatcher {
  private readonly db: AppDatabase;
  private readonly queue: TransactionalJobEnqueuer;
  private readonly registry: StepHandlerRegistry;
  private readonly logger: Logger;

  constructor(options: WorkflowExecutorOptions) {
    this.db = options.db;
    this.queue = options.queue;
    this.registry = options.registry;
    this.logger = options.logger;
  }

  async dispatch(job: ClaimedJob): Promise<void> {
    const outcome = await this.db.transaction((tx) => this.advance(tx, job));

    if (outcome.settle === 'fail') {
      // The failure is already durably recorded (step run + run marked failed in
      // the committed transaction). Signal the worker to fail the queue job with
      // the same reason, rather than complete it.
      throw new StepFailedError(outcome.reason);
    }
    // 'complete': the worker marks the job done. Nothing more to do here.
  }

  /**
   * The whole of one step's execution, inside a single transaction. Returns how
   * the worker should settle the queue job. Business failures are recorded and
   * returned as `{ settle: 'fail' }` (not thrown), so the failure is committed
   * with the transaction before the worker acts on it.
   */
  private async advance(tx: Transaction, job: ClaimedJob): Promise<Outcome> {
    // The run, locked for the length of this transaction. FOR UPDATE serialises
    // any concurrent attempt on the same run and is the linchpin of idempotency.
    const [run] = await tx
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.tenantId, job.tenantId), eq(workflowRuns.id, job.runId)))
      .for('update');

    if (run === undefined) {
      // The worker already checks existence, but a run could vanish between claim
      // and dispatch. Deterministic: fail the job, do not leave it for the reaper.
      return { settle: 'fail', reason: { code: 'run_not_found', message: 'workflow run does not exist' } };
    }

    const log = withContext(this.logger, { tenant_id: job.tenantId, run_id: job.runId }).child({
      job_id: job.id,
      step_key: job.stepKey,
      attempt: job.attempt,
      worker_id: job.lockedBy,
    });

    const runStatus = run.status as RunStatus;

    // Idempotency guard 1: the run has already finished. A redelivered job for a
    // terminal run does no work — its outcome is already sealed and recorded.
    if (runStatus === 'succeeded' || runStatus === 'failed' || runStatus === 'cancelled') {
      log.info({ run_status: runStatus }, 'job_skipped_run_terminal');
      return { settle: 'complete', detail: 'run_terminal' };
    }

    // Idempotency guard 2: the run has advanced past this step (a prior attempt
    // committed and enqueued the next job, but its queue completion was lost).
    // Re-executing would double-advance; instead, complete this stale job.
    if (run.currentStepKey !== job.stepKey) {
      log.info({ current_step_key: run.currentStepKey }, 'job_skipped_step_superseded');
      return { settle: 'complete', detail: 'step_superseded' };
    }

    // Version pinning: execute the exact version the run pinned at creation, never
    // "the current active version".
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
      return { settle: 'fail', reason };
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
      return { settle: 'fail', reason };
    }

    return this.executeStep(tx, job, run, definition, stepIndex, log);
  }

  /**
   * Execute one step: resolve its input, record a `running` step run, invoke the
   * handler, then either advance the run to the next step (enqueuing its job) or
   * finish the run — all still inside `tx`.
   */
  private async executeStep(
    tx: Transaction,
    job: ClaimedJob,
    run: WorkflowRun,
    definition: WorkflowDefinition,
    stepIndex: number,
    log: Logger,
  ): Promise<Outcome> {
    const step = definition.steps[stepIndex]!;
    // queued → running (or running → running on a fresh attempt). Guards upstream
    // guarantee the run is non-terminal, so this cannot illegally jump states.
    assertRunTransition(run.status as RunStatus, 'running');

    const context = new ExecutionContext(run.context as unknown as RunContext);
    const startedAt = new Date();

    // Resolve references in the step's config before anything is recorded as
    // running — an unresolved reference is a clean, deterministic failure.
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
        attempt: job.attempt,
        status: 'failed',
        error: reason,
        startedAt,
        finishedAt: new Date(),
        durationMs: 0,
      });
      await this.markRunFailed(tx, job, run, context.snapshot(), reason);
      log.warn({ reason: reason.code }, 'step_failed');
      log.error({ reason: reason.code }, 'run_failed');
      return { settle: 'fail', reason };
    }

    const [stepRun] = await tx
      .insert(workflowStepRuns)
      .values({
        tenantId: job.tenantId,
        runId: job.runId,
        stepKey: step.key,
        stepType: step.type,
        attempt: job.attempt,
        status: 'running',
        input,
        startedAt,
      })
      .returning({ id: workflowStepRuns.id });
    const stepRunId = stepRun!.id;

    const stepLog = log.child({ step_run_id: stepRunId, step_type: step.type });
    stepLog.info('step_started');

    let output: unknown;
    try {
      output = await this.registry.get(step.type).execute({ step, context, input });
    } catch (error) {
      // A business failure: the step ran and failed deterministically. Record it
      // and mark the run failed — committed with this transaction.
      const reason = toJobError(error);
      const finishedAt = new Date();
      await tx
        .update(workflowStepRuns)
        .set({
          status: 'failed',
          error: reason,
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        })
        .where(eq(workflowStepRuns.id, stepRunId));
      await this.markRunFailed(tx, job, run, context.snapshot(), reason);
      stepLog.warn({ reason: reason.code }, 'step_failed');
      stepLog.error({ reason: reason.code }, 'run_failed');
      return { settle: 'fail', reason };
    }

    // Success: settle the step run and record its output in the context.
    const finishedAt = new Date();
    await tx
      .update(workflowStepRuns)
      .set({
        status: 'succeeded',
        output,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      })
      .where(eq(workflowStepRuns.id, stepRunId));
    context.setStepOutput(step.key, output);
    stepLog.info('step_succeeded');

    const nextStep = definition.steps[stepIndex + 1];
    if (nextStep !== undefined) {
      // Advance: point the run at the next step, persist the grown context, and
      // enqueue exactly one job for it — atomic with everything above.
      assertRunTransition('running', 'running');
      await tx
        .update(workflowRuns)
        .set({
          status: 'running',
          currentStepKey: nextStep.key,
          startedAt: run.startedAt ?? startedAt,
          context: context.snapshot() as unknown as Record<string, unknown>,
        })
        .where(and(eq(workflowRuns.tenantId, job.tenantId), eq(workflowRuns.id, job.runId)));
      await this.queue.enqueue(
        { tenantId: job.tenantId, runId: job.runId, stepKey: nextStep.key },
        tx,
      );
      log.info({ next_step_key: nextStep.key }, 'run_advanced');
      return { settle: 'complete', detail: 'advanced' };
    }

    // No next step: the run is complete.
    assertRunTransition('running', 'succeeded');
    await tx
      .update(workflowRuns)
      .set({
        status: 'succeeded',
        currentStepKey: null,
        startedAt: run.startedAt ?? startedAt,
        finishedAt,
        context: context.snapshot() as unknown as Record<string, unknown>,
      })
      .where(and(eq(workflowRuns.tenantId, job.tenantId), eq(workflowRuns.id, job.runId)));
    log.info('run_succeeded');
    return { settle: 'complete', detail: 'run_succeeded' };
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
