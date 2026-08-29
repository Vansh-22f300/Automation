/**
 * Worker process entrypoint.
 *
 * Step 5 scope: a real queue consumer. This process boots, connects to
 * PostgreSQL, and runs two long-lived loops against the `jobs` table:
 *
 *   - a `Worker` that claims one pending job at a time (`FOR UPDATE SKIP
 *     LOCKED`), verifies the job's run exists, and hands it to a dispatcher;
 *   - a `Reaper` that periodically returns jobs with expired leases to the
 *     queue, so a crashed worker never loses its in-flight work.
 *
 * What it deliberately does *not* do yet is execute workflow steps. The
 * dispatcher is `UnimplementedStepDispatcher`, which refuses every step; the
 * worker records that refusal as a clear, terminal job failure. No job is ever
 * marked `done` here, because no work is actually performed — the real executor
 * arrives in Step 6 as a drop-in `StepDispatcher`.
 *
 * The composition root wires the real dependencies (database, queue, dispatcher)
 * and owns process concerns: startup verification, signal handling, and a clean
 * shutdown that stops claiming, drains the loops, and closes the pool.
 */

import { and, eq } from 'drizzle-orm';

import { loadEnv } from '@/config/env.js';
import { createDatabase } from '@/db/client.js';
import { workflowRuns } from '@/db/schema.js';
import { newId } from '@/domain/ids.js';
import { createLogger } from '@/observability/logger.js';
import { PostgresJobQueue } from '@/repositories/job-queue.js';
import { UnimplementedStepDispatcher } from '@/worker/dispatcher.js';
import { Reaper } from '@/worker/reaper.js';
import { Worker } from '@/worker/worker.js';
import type { RunExistenceCheck } from '@/worker/worker.js';

/** How long to wait after finding no work before polling again. */
const POLL_INTERVAL_MS = 1_000;
/** How often the reaper sweeps for expired leases. */
const REAPER_INTERVAL_MS = 30_000;

const env = loadEnv();
const logger = createLogger(env, { service: 'worker' });

// A stable identity for this process, stamped onto every lease it takes and
// every log line it writes, so a job can be traced to the worker that ran it.
const workerId = `worker-${process.pid}-${newId().slice(0, 8)}`;

const database = createDatabase(env, logger, { service: 'worker' });
const queue = new PostgresJobQueue(database.db);

/** The worker's job-validity check: does this run still exist for this tenant? */
const runExists: RunExistenceCheck = async (tenantId, runId) => {
  const [row] = await database.db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.tenantId, tenantId), eq(workflowRuns.id, runId)))
    .limit(1);
  return row !== undefined;
};

const worker = new Worker({
  queue,
  dispatcher: new UnimplementedStepDispatcher(),
  logger,
  workerId,
  pollIntervalMs: POLL_INTERVAL_MS,
  runExists,
});

const reaper = new Reaper({ queue, logger, intervalMs: REAPER_INTERVAL_MS });

let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ reason, worker_id: workerId }, 'worker shutting down');

  try {
    // Stop claiming new work first, then stop the reaper, then release the pool.
    // Draining the loops before closing the pool avoids tearing a connection out
    // from under an in-flight claim or sweep.
    await worker.stop();
    await reaper.stop();
    await database.close();
    logger.info('worker stopped cleanly');
  } catch (error) {
    logger.error({ err: error }, 'worker shutdown failed');
    process.exitCode = 1;
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exitCode = 1;
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  process.exitCode = 1;
  void shutdown('uncaughtException');
});

try {
  // A worker that cannot reach the database has nothing to do; fail the boot and
  // let the supervisor restart it.
  await database.verifyConnection();

  worker.start();
  reaper.start();

  logger.info(
    {
      node_env: env.NODE_ENV,
      worker_id: workerId,
      poll_interval_ms: POLL_INTERVAL_MS,
      reaper_interval_ms: REAPER_INTERVAL_MS,
    },
    'worker running',
  );
} catch (error) {
  logger.fatal({ err: error }, 'worker failed to start');
  await database.close().catch(() => undefined);
  process.exit(1);
}
