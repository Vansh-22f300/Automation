/**
 * Worker process entrypoint.
 *
 * Step 2 scope: prove that a long-lived background process boots, connects to
 * PostgreSQL, does periodic work, and stops cleanly on demand. The heartbeat is
 * a placeholder for the real claim loop (Step 5), which will replace it with:
 *
 *   claim a job (FOR UPDATE SKIP LOCKED) -> execute one step -> persist ->
 *   enqueue the next job
 *
 * The database handle is created and verified here because that claim loop will
 * need it. There is deliberately no queue, job table, or step execution yet — the
 * connection is opened and nothing reads from it.
 */

import { loadEnv } from '@/config/env.js';
import { createDatabase } from '@/db/client.js';
import { createLogger } from '@/observability/logger.js';

/** Heartbeat cadence. Becomes the queue poll interval in Step 5. */
const TICK_INTERVAL_MS = 1_000;

const env = loadEnv();
const logger = createLogger(env, { service: 'worker' });

const database = createDatabase(env, logger, { service: 'worker' });

let ticks = 0;
let ticker: NodeJS.Timeout | undefined;
let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ reason, ticks }, 'worker shutting down');
  if (ticker !== undefined) clearInterval(ticker);

  try {
    // Once the queue exists, the in-flight job's lease is released here —
    // before the pool goes away — so another worker can pick it up immediately
    // instead of waiting for the lease to expire.
    await database.close();
    // No process.exit(): letting the event loop drain naturally allows the log
    // transport to flush.
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
  // Before the heartbeat starts. A worker that cannot reach the database has
  // nothing to do, and a supervisor restart is the correct response.
  await database.verifyConnection();

  ticker = setInterval(() => {
    ticks += 1;
    // Logged at info so the heartbeat is visible during verification. This drops
    // to debug once real job processing produces meaningful output.
    logger.info({ tick: ticks }, 'worker tick');
  }, TICK_INTERVAL_MS);

  logger.info(
    { node_env: env.NODE_ENV, tick_interval_ms: TICK_INTERVAL_MS },
    'worker started (no queue attached yet)',
  );
} catch (error) {
  logger.fatal({ err: error }, 'worker failed to start');
  await database.close().catch(() => undefined);
  process.exit(1);
}
