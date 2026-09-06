/**
 * Workflow list endpoint.
 *
 *   GET /v1/workflows
 *
 * Tenant-scoped, read-only, keyset-paginated. The tenant identity always comes
 * from the authenticated API key; no tenant selector is accepted from the URL,
 * body or query string.
 */

import { z } from "zod";

import { requireAuth } from "@/api/auth-hook.js";
import { BadRequestError } from "@/api/errors.js";
import type { ApiServer } from "@/api/types.js";
import type { AuthContext } from "@/auth/context.js";
import type { WorkflowListReader } from "@/repositories/workflow-repository.js";

export type WorkflowServiceFactory = (auth: AuthContext) => WorkflowListReader;

const workflowListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).optional(),
});

function parseQuery(query: unknown) {
  const parsed = workflowListQuery.safeParse(query);
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues[0]?.message ?? "Invalid query",
    );
  }
  return parsed.data;
}

export function registerWorkflowRoutes(
  app: ApiServer,
  workflowFor: WorkflowServiceFactory,
): void {
  app.get("/v1/workflows", async (request, reply) => {
    const auth = requireAuth(request);
    const query = parseQuery(request.query);
    const page = await workflowFor(auth).listWorkflows(
      query.limit,
      query.cursor,
    );

    return reply.code(200).send({
      items: page.items,
      page: {
        limit: query.limit ?? 20,
        nextCursor: page.nextCursor,
      },
    });
  });
}
