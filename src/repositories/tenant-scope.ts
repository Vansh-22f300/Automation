/**
 * The tenant-isolation pattern every repository follows.
 *
 * The rule this file exists to enforce: **no tenant-scoped query runs without a
 * tenant id.** The most damaging bug class in a multi-tenant system is a query
 * that forgets its tenant predicate and quietly returns — or mutates — another
 * customer's data. We make that hard to write rather than trusting every future
 * author to remember.
 *
 * The mechanism is a `TenantScope`: a small value that binds a database handle to
 * exactly one tenant id. Repositories are constructed *from* a scope, never from
 * a bare database handle, so a repository instance is intrinsically pinned to one
 * tenant and its methods have no way to reach across tenants. The tenant id is
 * not an optional argument a caller might drop — it is baked into the object.
 *
 * The single legitimate exception (resolving a tenant *from* an API key, before
 * any tenant is known) is deliberately kept out of this layer entirely — see
 * `@/auth/api-key-store`.
 *
 * Row-Level Security in Postgres will later back this with a database-enforced
 * guarantee. Until then this application-layer pattern is the isolation boundary,
 * and it is proven end-to-end by the tenant-isolation tests.
 */

import { and, eq } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import type { AppDatabase } from '@/db/client.js';

/**
 * A database handle bound to a single tenant. Construct one per authenticated
 * request (from `request.auth.tenantId`) and hand it to repositories.
 */
export class TenantScope {
  constructor(
    readonly db: AppDatabase,
    readonly tenantId: string,
  ) {}

  /**
   * Build a WHERE predicate that is *always* anchored to this tenant, then
   * ANDed with any additional conditions. Repositories use this so the tenant
   * predicate cannot be omitted: there is no code path that adds a condition
   * without it.
   *
   * @param tenantColumn the `tenant_id` column of the table being queried
   */
  where(tenantColumn: PgColumn, ...conditions: SQL[]): SQL {
    const predicate = and(eq(tenantColumn, this.tenantId), ...conditions);
    // `and` only returns undefined when given no arguments; we always pass at
    // least the tenant predicate, so this is non-null. Assert for the types.
    return predicate as SQL;
  }
}

/**
 * Base class for tenant-scoped repositories. Subclasses get `this.scope` and,
 * conventionally, only ever query through `scope.where(...)`.
 */
export abstract class TenantScopedRepository {
  protected constructor(protected readonly scope: TenantScope) {}

  protected get db(): AppDatabase {
    return this.scope.db;
  }

  protected get tenantId(): string {
    return this.scope.tenantId;
  }
}
