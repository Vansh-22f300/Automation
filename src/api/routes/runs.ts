/**
 * Run inspection endpoint.
 *
 *   GET /v1/runs/:runId
 *   GET /v1/runs
 *
 * A read-only, tenant-scoped view of one workflow run. The tenant comes from the
 * authenticated API key (`request.auth.tenantId`) and NEVER from the URL, body or
 * query — the run id is the only input, and it is resolved *within* the caller's
 * tenant. A run that does not exist for this tenant, whether truly absent or owned
 * by someone else, returns the exact same 404 as any other miss: a tenant cannot
 * probe for the existence of another tenant's runs.
 *
 * The detail response is summary-only, byte-for-byte the same `RunInspection` DTO
 * the CLI renders — the repository is the single source of truth for shape and
 * redaction. There is deliberately no `--detail`-style raw mode on the API yet;
 * exposing raw payload/context/output over HTTP is reserved for a future endpoint
 * with its own authorization model.
 *
 * The collection endpoint (`GET /v1/runs`) is also read-only and tenant-scoped,
 * returning keyset-paginated summary rows with optional status/workflow filters.
 * It does not expose payload/context internals, tool arguments, or mutation paths.
 */

import { z } from "zod";

import { requireAuth } from "@/api/auth-hook.js";
import { BadRequestError, NotFoundError } from "@/api/errors.js";
import type { ApiServer } from "@/api/types.js";
import type { AuthContext } from "@/auth/context.js";
import type {
  RunInspectionReader,
  RunListReader,
} from "@/repositories/run-inspection-repository.js";

/** Builds the tenant-scoped run-inspection reader for an authenticated request. */
export type RunInspectionServiceFactory = (
  auth: AuthContext,
) => RunInspectionReader & RunListReader;

const runStatusValues = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const;

const runListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).optional(),
  status: z.enum(runStatusValues).optional(),
  workflowId: z.string().uuid().optional(),
});

function parseQuery(query: unknown) {
  const parsed = runListQuery.safeParse(query);
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues[0]?.message ?? "Invalid query",
    );
  }
  return parsed.data;
}

export function registerRunInspectionRoutes(
  app: ApiServer,
  runInspectionFor: RunInspectionServiceFactory,
): void {
  app.get("/v1/runs/:runId", async (request, reply) => {
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

  app.get("/v1/runs", async (request, reply) => {
    const auth = requireAuth(request);
    const query = parseQuery(request.query);
    const options = {
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.workflowId !== undefined
        ? { workflowId: query.workflowId }
        : {}),
    };
    const page = await runInspectionFor(auth).listRuns(options);

    return reply.code(200).send({
      items: page.items,
      page: {
        limit: query.limit ?? 20,
        nextCursor: page.nextCursor,
      },
    });
  });
}
