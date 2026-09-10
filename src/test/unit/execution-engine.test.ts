/**
 * The execution engine's two-transaction boundary.
 *
 * `WorkflowExecutor.dispatch` must advance a run in three distinct phases:
 *
 *   Transaction A (beginStep)   — lock the run, guard, INSERT a `running` step_run, COMMIT
 *   Handler       (invokeHandler) — execute the step with NO transaction open
 *   Transaction B (settleStep)  — lock the run, settle the step_run, advance/finish, COMMIT
 *
 * The handler is where the slow, external work happens (Slack, an LLM round-trip,
 * a tool call). Running it inside a transaction would pin a pooled connection and
 * hold `FOR UPDATE` row locks for the entire duration of a third-party API call —
 * the exact failure the two-transaction model exists to prevent.
 *
 * That property is invisible to the integration suite: those tests drive `dispatch`
 * end to end and assert on the rows it leaves behind, so they pass just as happily
 * against the old single-transaction engine. This test asserts the boundary itself.
 * The database is a stand-in whose `transaction()` tracks nesting depth, and the
 * step handler records that depth at the moment it runs — so if the handler is ever
 * moved back inside a transaction, this fails immediately and by name.
 */

import pino from 'pino';
import { describe, expect, it } from 'vitest';

import type { AppDatabase } from '@/db/client.js';
import { llmUsage, workflowRuns, workflowStepRuns, workflowVersions } from '@/db/schema.js';
import type { ClaimedJob } from '@/domain/queue.js';
import { StepHandlerRegistry } from '@/domain/step-handler.js';
import type { StepHandler } from '@/domain/step-handler.js';
import { WorkflowExecutor } from '@/repositories/execution-engine.js';
import type { TransactionalJobEnqueuer } from '@/repositories/job-queue.js';

const TENANT_ID = '019218b0-0000-7000-8000-000000000001';
const RUN_ID = '019218b0-0000-7000-8000-000000000002';
const VERSION_ID = '019218b0-0000-7000-8000-000000000003';
const STEP_RUN_ID = '019218b0-0000-7000-8000-000000000004';
const JOB_ID = '019218b0-0000-7000-8000-000000000005';
const STEP_KEY = 'only_step';

/** A single `noop` step: no next step, so settleStep finishes the run outright. */
const DEFINITION = {
  version: 1,
  steps: [{ key: STEP_KEY, type: 'noop', config: {} }],
};

/** The `workflow_runs` row Transaction A locks: mid-flight, pointed at our step. */
const RUN_ROW = {
  id: RUN_ID,
  tenantId: TENANT_ID,
  workflowVersionId: VERSION_ID,
  status: 'running',
  currentStepKey: STEP_KEY,
  context: { trigger: { source: 'test', event_id: 'evt-1', payload: {} }, steps: {} },
  startedAt: null,
  finishedAt: null,
  error: null,
};

const JOB: ClaimedJob = {
  id: JOB_ID,
  tenantId: TENANT_ID,
  runId: RUN_ID,
  stepKey: STEP_KEY,
  attempt: 0,
  retryCount: 0,
  maxAttempts: 3,
  lockedBy: 'worker-under-test',
  leaseExpiresAt: new Date('2026-01-01T00:15:00.000Z'),
};

/** The rows each statement resolves to, keyed by the table the chain named. */
function rowsFor(table: unknown): readonly unknown[] {
  if (table === workflowRuns) return [RUN_ROW];
  if (table === workflowVersions) return [{ definition: DEFINITION }];
  if (table === workflowStepRuns) return [{ id: STEP_RUN_ID }];
  if (table === llmUsage) return [];
  return [];
}

/**
 * A stand-in for a Drizzle query builder. Every chained call returns the same
 * object, and awaiting it (it is a thenable, exactly as Drizzle's builders are)
 * yields the rows for whichever table the chain named. This covers the whole
 * statement surface the engine uses — select/insert/update, `.for('update')`,
 * `.returning()` — without a database.
 */
interface FakeQueryBuilder {
  from(table: unknown): FakeQueryBuilder;
  where(...args: readonly unknown[]): FakeQueryBuilder;
  for(...args: readonly unknown[]): FakeQueryBuilder;
  set(...args: readonly unknown[]): FakeQueryBuilder;
  values(...args: readonly unknown[]): FakeQueryBuilder;
  returning(...args: readonly unknown[]): FakeQueryBuilder;
  then(
    onFulfilled: (rows: readonly unknown[]) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ): unknown;
}

function fakeQueryBuilder(initialTable?: unknown): FakeQueryBuilder {
  let table = initialTable;
  const builder: FakeQueryBuilder = {
    from(t) {
      table = t;
      return builder;
    },
    where: () => builder,
    for: () => builder,
    set: () => builder,
    values: () => builder,
    returning: () => builder,
    then: (onFulfilled, onRejected) =>
      Promise.resolve(rowsFor(table)).then(onFulfilled, onRejected),
  };
  return builder;
}

interface Harness {
  readonly executor: WorkflowExecutor;
  /** Every transaction boundary and handler invocation, in the order they happened. */
  readonly events: readonly string[];
  /** How many transactions were open at the instant the handler ran. */
  txDepthDuringHandler(): number | null;
}

function createHarness(): Harness {
  const events: string[] = [];
  let txDepth = 0;
  let txDepthDuringHandler: number | null = null;

  const tx = {
    select: () => fakeQueryBuilder(),
    insert: (table: unknown) => fakeQueryBuilder(table),
    update: (table: unknown) => fakeQueryBuilder(table),
  };

  const db = {
    async transaction<T>(callback: (executor: unknown) => Promise<T>): Promise<T> {
      txDepth += 1;
      events.push('tx:begin');
      try {
        return await callback(tx);
      } finally {
        events.push('tx:commit');
        txDepth -= 1;
      }
    },
  };

  // The handler under observation: it records the transaction depth it sees.
  const handler: StepHandler = {
    execute() {
      txDepthDuringHandler = txDepth;
      events.push('handler');
      return Promise.resolve({ output: { ok: true } });
    },
  };

  // A one-step definition never advances, so a call here means the engine took a
  // path this test did not intend — fail loudly rather than silently.
  const queue: TransactionalJobEnqueuer = {
    enqueue() {
      throw new Error('a single-step definition must not enqueue a next job');
    },
  };

  const executor = new WorkflowExecutor({
    db: db as unknown as AppDatabase,
    queue,
    registry: new StepHandlerRegistry().register('noop', handler),
    logger: pino({ level: 'silent' }),
  });

  return { executor, events, txDepthDuringHandler: () => txDepthDuringHandler };
}

describe('WorkflowExecutor transaction boundary', () => {
  it('runs the step handler outside any database transaction', async () => {
    const harness = createHarness();

    await harness.executor.dispatch(JOB);

    // The load-bearing assertion: no transaction was open while the handler ran.
    // Under the old single-transaction engine this is 1, not 0.
    expect(harness.txDepthDuringHandler()).toBe(0);

    // ...and the handler ran strictly *between* two committed transactions, rather
    // than inside one. The old engine produces ['tx:begin', 'handler', 'tx:commit'].
    expect(harness.events).toEqual([
      'tx:begin', // Transaction A — beginStep
      'tx:commit',
      'handler', // no transaction open here
      'tx:begin', // Transaction B — settleStep
      'tx:commit',
    ]);
  });
});
