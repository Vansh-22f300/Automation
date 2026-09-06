/**
 * Connection list endpoint.
 *
 *   GET /v1/connections
 *
 * Read-only, tenant-scoped, and metadata-only. The decrypted credential never
 * crosses this boundary.
 */

import { z } from "zod";

import { requireAuth } from "@/api/auth-hook.js";
import { BadRequestError } from "@/api/errors.js";
import type { ApiServer } from "@/api/types.js";
import type { AuthContext } from "@/auth/context.js";
import type { ConnectionListReader } from "@/repositories/connection-repository.js";

export type ConnectionServiceFactory = (
  auth: AuthContext,
) => ConnectionListReader;

const connectionListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).optional(),
});

function parseQuery(query: unknown) {
  const parsed = connectionListQuery.safeParse(query);
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues[0]?.message ?? "Invalid query",
    );
  }
  return parsed.data;
}

export function registerConnectionRoutes(
  app: ApiServer,
  connectionFor: ConnectionServiceFactory,
): void {
  app.get("/v1/connections", async (request, reply) => {
    const auth = requireAuth(request);
    const query = parseQuery(request.query);
    const options = {
      limit: query.limit ?? 20,
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    };
    const page = await connectionFor(auth).listMetadataPage(options);

    return reply.code(200).send({
      items: page.items,
      page: {
        limit: query.limit ?? 20,
        nextCursor: page.nextCursor,
      },
    });
  });
}
