/**
 * API process entrypoint.
 *
 * Step 2 scope: boot a Fastify server, connect to PostgreSQL, log clearly, shut
 * both down cleanly. There are intentionally NO routes yet — health checks,
 * webhook ingestion and authentication arrive in Steps 3 and 4. An unmatched
 * request returns Fastify's default 404, which is itself proof the server is
 * serving.
 *
 * The database handle is created here and would be handed to route handlers and
 * services as they appear. Nothing below reads it yet; the wiring exists so that
 * a misconfigured or unreachable database is caught at boot rather than by the
 * first user request.
 */

import Fastify from 'fastify';
import { loadEnv } from '@/config/env.js';
import { createDatabase } from '@/db/client.js';
import { createLogger } from '@/observability/logger.js';

/** Time allowed for in-flight requests to drain before we stop waiting. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

const env = loadEnv();
const logger = createLogger(env, { service: 'api' });

const database = createDatabase(env, logger, { service: 'api' });

const app = Fastify({
  loggerInstance: logger,
  // 1 MiB. Webhook payloads are small; a low ceiling is a cheap DoS guard.
  bodyLimit: 1_048_576,
  // Flip on only when running behind a proxy we control, so X-Forwarded-For
  // cannot be spoofed to defeat rate limiting.
  trustProxy: false,
});

let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ reason }, 'api shutting down');

  const timeout = setTimeout(() => {
    logger.error({ timeout_ms: SHUTDOWN_TIMEOUT_MS }, 'api shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timeout.unref();

  try {
    // Order matters: stop accepting and finish in-flight requests first, then
    // drain the pool. Closing the database while a request still holds a
    // connection would turn a clean shutdown into a burst of 500s.
    await app.close();
    await database.close();
    logger.info('api stopped cleanly');
  } catch (error) {
    logger.error({ err: error }, 'api shutdown failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
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
  // Before the port opens. A process that is listening but cannot reach its
  // database is worse than one that never started: it looks healthy to whatever
  // is watching it.
  await database.verifyConnection();

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info(
    { host: env.HOST, port: env.PORT, node_env: env.NODE_ENV },
    'api listening (no routes registered yet)',
  );
} catch (error) {
  logger.fatal({ err: error }, 'api failed to start');
  await database.close().catch(() => undefined);
  process.exit(1);
}
