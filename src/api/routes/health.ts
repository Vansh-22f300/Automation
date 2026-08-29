/**
 * GET /healthz — liveness and database readiness.
 *
 * Public and unauthenticated: a health probe should not need a credential, and
 * the endpoint reveals nothing sensitive. It distinguishes two things a load
 * balancer or orchestrator cares about separately:
 *
 * - **The process is alive** — if this handler runs at all, the event loop is
 *   turning. Always reported `ok`.
 * - **The database is reachable** — a bounded `select 1`. If it fails the overall
 *   status is `degraded` and the response is **503**, so an orchestrator will not
 *   route traffic to an instance that cannot serve it.
 *
 * The body is intentionally spartan: a status, the two sub-checks, and uptime.
 * No `DATABASE_URL`, no host, no error text, no configuration — a health endpoint
 * is often exposed more freely than the rest of the API and must leak nothing.
 */

import type { ApiServer } from '@/api/types.js';

/** Probes the database. Resolves if reachable, rejects otherwise. */
export type DatabaseHealthCheck = () => Promise<void>;

interface HealthResponse {
  readonly status: 'ok' | 'degraded';
  readonly checks: {
    readonly process: 'ok';
    readonly database: 'ok' | 'down';
  };
  readonly uptimeSeconds: number;
}

export function registerHealthRoute(app: ApiServer, checkDatabase: DatabaseHealthCheck): void {
  app.get(
    '/healthz',
    // Exempt from the rate limiter: a liveness probe must not be throttled into
    // false failures, and it exposes nothing worth protecting.
    { config: { rateLimit: false } },
    async (request, reply) => {
      let database: 'ok' | 'down' = 'ok';
      try {
        await checkDatabase();
      } catch (error) {
        database = 'down';
        // Log the real reason server-side; never put it in the response.
        request.log.warn({ err: error }, 'health check: database unreachable');
      }

      const body: HealthResponse = {
        status: database === 'ok' ? 'ok' : 'degraded',
        checks: { process: 'ok', database },
        uptimeSeconds: Math.round(process.uptime()),
      };

      return reply.code(database === 'ok' ? 200 : 503).send(body);
    },
  );
}
