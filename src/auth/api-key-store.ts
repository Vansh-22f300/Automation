/**
 * The one deliberately un-tenant-scoped data path in the system.
 *
 * Authentication is a chicken-and-egg case: a request presents a key *in order to
 * discover which tenant it belongs to*, so the lookup cannot itself be scoped to
 * a tenant. That makes it exactly the kind of "queries across all tenants" access
 * the repository layer otherwise forbids — so it is confined here, to a narrow
 * interface used only by the authenticator, and named to make its exceptional
 * nature obvious. Every *other* api-key operation goes through the tenant-scoped
 * `ApiKeyRepository` instead.
 *
 * The interface is kept minimal and storage-agnostic so the authenticator can be
 * unit-tested against a fake without a database.
 */

import { eq, sql } from 'drizzle-orm';

import type { AppDatabase } from '@/db/client.js';
import { apiKeys } from '@/db/schema.js';

/** The only fields authentication needs about a key. Deliberately not the whole row. */
export interface AuthApiKeyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly keyHash: string;
  /** Non-null if the key has been revoked. */
  readonly revokedAt: Date | null;
}

export interface ApiKeyStore {
  /** Resolve the single candidate key for a prefix, or null if none exists. */
  findByPrefix(prefix: string): Promise<AuthApiKeyRecord | null>;
  /** Record that a key was just used. Best-effort; failures must not block auth. */
  touchLastUsed(id: string): Promise<void>;
}

/** Postgres-backed store. The prefix lookup hits the unique `api_keys_prefix_key` index. */
export class DrizzleApiKeyStore implements ApiKeyStore {
  constructor(private readonly db: AppDatabase) {}

  async findByPrefix(prefix: string): Promise<AuthApiKeyRecord | null> {
    const rows = await this.db
      .select({
        id: apiKeys.id,
        tenantId: apiKeys.tenantId,
        keyHash: apiKeys.keyHash,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.prefix, prefix))
      .limit(1);

    return rows[0] ?? null;
  }

  async touchLastUsed(id: string): Promise<void> {
    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(apiKeys.id, id));
  }
}
