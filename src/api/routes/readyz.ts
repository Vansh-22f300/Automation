/**
 * GET /readyz — process readiness.
 *
 * Distinct from `/healthz`, which only proves the event loop is turning.
 * Readiness proves this process can *serve traffic right now*: the in-memory
 * dependencies it relies on (here, the PostgreSQL pool) are reachable. A
 * failing readiness check is a signal to the load balancer / orchestrator to
 * stop routing traffic to this instance until the dependency recovers.
 *
 * The probe is a bounded `select 1` against the existing pool, the same
 * closure passed to `/healthz` historically. The result is binary: 200 with
 * `status: "ready"` if the probe resolves, 503 with `status: "not_ready"`
 * if it rejects. The body is intentionally small — a status, the two
 * sub-checks, and uptime — and never includes the connection string, the
 * host, the error message, or any configuration. The real reason for the
 * failure is logged server-side only.
 *
 * The endpoint is public, unauthenticated, and exempt from the rate limiter
 * for the same reasons as `/healthz`: a readiness probe is not a credential,
 * and throttling it would create false negatives during the very incidents it
 * is meant to detect.
 *
 * Worker state is intentionally NOT included. The worker runs in a separate
 * process; this process has no way to read its state. Coupling API readiness
 * to worker activity would make a healthy API report "not ready" just
 * because the worker is down — which is a separate operational signal that
 * belongs to a separate observability point (worker structured logs).
 */

import type { ApiServer } from '@/api/types.js';
import type { DatabaseHealthCheck } from './health.js';

interface ReadyzResponse {
  readonly status: 'ready' | 'not_ready';
  readonly checks: {
    readonly process: 'ok';
    readonly database: 'ok' | 'down';
  };
  readonly uptimeSeconds: number;
}

export function registerReadyzRoute(app: ApiServer, checkDatabase: DatabaseHealthCheck): void {
  app.get(
    '/readyz',
    // Exempt from the rate limiter for the same reasons as `/healthz`: a
    // readiness probe must not be throttled into false failures.
    { config: { rateLimit: false } },
    async (request, reply) => {
      let database: 'ok' | 'down' = 'ok';
      try {
        await checkDatabase();
      } catch (error) {
        database = 'down';
        // Log the real reason server-side; never put it in the response.
        request.log.warn({ err: error }, 'readyz check: database unreachable');
      }

      const body: ReadyzResponse = {
        status: database === 'ok' ? 'ready' : 'not_ready',
        checks: { process: 'ok', database },
        uptimeSeconds: Math.round(process.uptime()),
      };

      return reply.code(database === 'ok' ? 200 : 503).send(body);
    },
  );
}
