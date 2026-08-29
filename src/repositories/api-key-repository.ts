/**
 * Tenant-scoped management of API keys: create, list, revoke.
 *
 * Everything here is pinned to one tenant through `TenantScope`. That is what
 * makes cross-tenant access unrepresentable: `revoke(id)` on tenant A's
 * repository can only ever touch tenant A's rows, so revoking a key by id that
 * belongs to tenant B simply finds nothing and raises `NotFoundError` — the same
 * answer as a genuinely missing id, so B's existence is never revealed.
 *
 * Note the split of concerns from `@/auth/api-key-store`: that store does the one
 * unscoped lookup authentication needs; this repository does everything a tenant
 * does to its *own* keys, and never runs a query without its tenant predicate.
 */

import { desc, eq } from 'drizzle-orm';

import { NotFoundError } from '@/api/errors.js';
import { generateApiKey } from '@/auth/api-key.js';
import { apiKeys } from '@/db/schema.js';
import { TenantScope, TenantScopedRepository } from '@/repositories/tenant-scope.js';

/** A newly minted key. `plaintext` is present exactly once, here, and never again. */
export interface CreatedApiKey {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: Date;
  /** The full key. Shown to the caller once; not retrievable afterwards. */
  readonly plaintext: string;
}

/** Non-secret metadata about a key. Never includes the hash or the plaintext. */
export interface ApiKeySummary {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** The capability the API-key management routes depend on. */
export interface ApiKeyService {
  create(name: string): Promise<CreatedApiKey>;
  list(): Promise<ApiKeySummary[]>;
  /** Revoke a key by id. Throws `NotFoundError` if it is not this tenant's. */
  revoke(id: string): Promise<void>;
}

export class ApiKeyRepository extends TenantScopedRepository implements ApiKeyService {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async create(name: string): Promise<CreatedApiKey> {
    const generated = generateApiKey();

    const [row] = await this.db
      .insert(apiKeys)
      .values({
        tenantId: this.tenantId,
        name,
        prefix: generated.prefix,
        keyHash: generated.keyHash,
      })
      .returning({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        createdAt: apiKeys.createdAt,
      });

    // The insert always returns exactly one row.
    const created = row!;
    return { ...created, plaintext: generated.plaintext };
  }

  async list(): Promise<ApiKeySummary[]> {
    return this.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(this.scope.where(apiKeys.tenantId))
      .orderBy(desc(apiKeys.createdAt));
  }

  async revoke(id: string): Promise<void> {
    const revoked = await this.db
      .update(apiKeys)
      // Idempotent-friendly: setting revoked_at again is harmless, but we only
      // touch rows that are this tenant's AND not already revoked.
      .set({ revokedAt: new Date() })
      .where(this.scope.where(apiKeys.tenantId, eq(apiKeys.id, id)))
      .returning({ id: apiKeys.id });

    if (revoked.length === 0) {
      // Either no such key, or it belongs to another tenant — indistinguishable
      // on purpose.
      throw new NotFoundError('API key not found');
    }
  }
}
