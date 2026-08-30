/**
 * Run inspection endpoint.
 *
 *   GET /v1/runs/:runId
 *
 * A read-only, tenant-scoped view of one workflow run. The tenant comes from the
 * authenticated API key (`request.auth.tenantId`) and NEVER from the URL, body or
 * query — the run id is the only input, and it is resolved *within* the caller's
 * tenant. A run that does not exist for this tenant, whether truly absent or owned
 * by someone else, returns the exact same 404 as any other miss: a tenant cannot
 * probe for the existence of another tenant's runs.
 *
 * The response is summary-only, byte-for-byte the same `RunInspection` DTO the CLI
 * renders — the repository is the single source of truth for shape and redaction.
 * There is deliberately no `--detail`-style raw mode on the API yet; exposing raw
 * payload/context/output over HTTP is reserved for a future endpoint with its own
 * authorization model. The surface is intentionally minimal: no list, search,
 * pagination, filtering, or mutation.
 */

import { requireAuth } from '@/api/auth-hook.js';
import { NotFoundError } from '@/api/errors.js';
import type { ApiServer } from '@/api/types.js';
import type { AuthContext } from '@/auth/context.js';
import type { RunInspectionReader } from '@/repositories/run-inspection-repository.js';

/** Builds the tenant-scoped run-inspection reader for an authenticated request. */
export type RunInspectionServiceFactory = (auth: AuthContext) => RunInspectionReader;

export function registerRunInspectionRoutes(
  app: ApiServer,
  runInspectionFor: RunInspectionServiceFactory,
): void {
  app.get('/v1/runs/:runId', async (request, reply) => {
    const auth = requireAuth(request);
    const { runId } = request.params as { runId: string };

    // Summary-only: no `detail` is ever passed from the HTTP boundary.
    const inspection = await runInspectionFor(auth).getRun(runId);
    if (inspection === null) {
      // Identical to a nonexistent run — indistinguishable from cross-tenant.
      throw new NotFoundError();
    }

    return reply.code(200).send(inspection);
  });
}
