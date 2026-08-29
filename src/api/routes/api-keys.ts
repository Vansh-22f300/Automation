/**
 * Minimal, authenticated API-key management endpoints.
 *
 * These let an already-authenticated tenant manage its *own* keys. They are the
 * self-service surface; the very first key for a tenant is minted out-of-band by
 * the `cli/create-api-key` service function, since you cannot authenticate to
 * create your first credential.
 *
 *   POST   /v1/api-keys            { "name": "CI" }   → 201, returns the key ONCE
 *   GET    /v1/api-keys                               → 200, metadata only
 *   POST   /v1/api-keys/:id/revoke                    → 204
 *
 * Every handler is tenant-scoped through `request.auth.tenantId`: the service is
 * built for that tenant, so a caller can only ever see or revoke its own keys.
 * The created key's plaintext is in the creation response and nowhere else, ever.
 */

import { z } from 'zod';

import { requireAuth } from '@/api/auth-hook.js';
import { BadRequestError } from '@/api/errors.js';
import type { ApiServer } from '@/api/types.js';
import type { AuthContext } from '@/auth/context.js';
import type { ApiKeyService } from '@/repositories/api-key-repository.js';

/** Builds the tenant-scoped service for an authenticated request. */
export type ApiKeyServiceFactory = (auth: AuthContext) => ApiKeyService;

const createBody = z.object({
  name: z.string().trim().min(1, 'name must not be empty').max(200),
});

export function registerApiKeyRoutes(app: ApiServer, serviceFor: ApiKeyServiceFactory): void {
  app.post('/v1/api-keys', async (request, reply) => {
    const auth = requireAuth(request);

    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid request body');
    }

    const created = await serviceFor(auth).create(parsed.data.name);

    // 201 with the plaintext. This is the only time `key` is ever returned.
    return reply.code(201).send({
      id: created.id,
      name: created.name,
      prefix: created.prefix,
      createdAt: created.createdAt,
      key: created.plaintext,
      warning: 'Store this key now. It will not be shown again.',
    });
  });

  app.get('/v1/api-keys', async (request, reply) => {
    const auth = requireAuth(request);
    const keys = await serviceFor(auth).list();
    return reply.code(200).send({ apiKeys: keys });
  });

  app.post('/v1/api-keys/:id/revoke', async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = request.params as { id: string };

    // Throws NotFoundError (→ 404) if the id is not this tenant's key.
    await serviceFor(auth).revoke(id);
    return reply.code(204).send();
  });
}
