/**
 * GET /healthz — process liveness.
 *
 * Public and unauthenticated: a liveness probe should not need a credential,
 * and the endpoint reveals nothing sensitive. Its only job is to answer the
 * single question "is the event loop turning?" — if this handler runs at all,
 * the process is alive. It deliberately does NOT touch the database: a brief
 * DB blip must not make the load balancer tear down an instance whose Node
 * process is healthy. Database reachability is a separate concern that lives
 * on `/readyz`.
 *
 * The body is intentionally spartan: a status and uptime. No sub-checks, no
 * connection detail, no error text — a health endpoint is often exposed more
 * freely than the rest of the API and must leak nothing.
 *
 * The `DatabaseHealthCheck` type is still exported here because `/readyz`
 * reuses the same closure shape. The runtime check has moved; the contract
 * did not.
 */

import type { ApiServer } from '@/api/types.js';

/** Probes the database. Resolves if reachable, rejects otherwise. */
export type DatabaseHealthCheck = () => Promise<void>;

interface HealthResponse {
  readonly status: 'ok';
  readonly uptimeSeconds: number;
}

export function registerHealthRoute(app: ApiServer): void {
  app.get(
    '/healthz',
    // Exempt from the rate limiter: a liveness probe must not be throttled into
    // false failures, and it exposes nothing worth protecting.
    { config: { rateLimit: false } },
    async (_request, reply) => {
      const body: HealthResponse = {
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
      };
      return reply.code(200).send(body);
    },
  );
}
