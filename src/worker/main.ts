/**
 * Worker process entrypoint.
 *
 * Step 1 scope: prove that a long-lived background process boots, does periodic
 * work, and stops cleanly on demand. The heartbeat is a placeholder for the
 * real claim loop (Step 5), which will replace it with:
 *
 *   claim a job (FOR UPDATE SKIP LOCKED) -> execute one step -> persist ->
 *   enqueue the next job
 *
 * There is deliberately no queue, database, or step execution here yet.
 */

import { loadEnv } from '@/config/env.js';
import { createLogger } from '@/observability/logger.js';

/** Heartbeat cadence. Becomes the queue poll interval in Step 5. */
const TICK_INTERVAL_MS = 1_000;

const env = loadEnv();
const logger = createLogger(env, { service: 'worker' });

let ticks = 0;
let shuttingDown = false;

const ticker = setInterval(() => {
  ticks += 1;
  // Logged at info so the heartbeat is visible during Step 1 verification.
  // This drops to debug once real job processing produces meaningful output.
  logger.info({ tick: ticks }, 'worker tick');
}, TICK_INTERVAL_MS);

function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ reason, ticks }, 'worker shutting down');
  clearInterval(ticker);
  // No process.exit(): letting the event loop drain naturally allows the log
  // transport to flush. Once the queue exists, this is also where we will
  // release the lease on any in-flight job before exiting.
  logger.info('worker stopped cleanly');
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exitCode = 1;
  shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  process.exitCode = 1;
  shutdown('uncaughtException');
});

logger.info(
  { node_env: env.NODE_ENV, tick_interval_ms: TICK_INTERVAL_MS },
  'worker started (no queue attached yet)',
);
