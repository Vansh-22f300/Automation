/**
 * The tenant-blind lookup path for *human* login — the third and last
 * deliberately un-tenant-scoped data path, alongside `@/auth/api-key-store` and
 * `@/auth/session-store`.
 *
 * Login is the same chicken-and-egg case those stores document: a person
 * presents an email and password *in order to discover which tenant(s) they may
 * act in*, so the lookup cannot be scoped to a tenant — the tenant is the
 * answer, never the caller's input. Identity is global (`users` has no
 * `tenant_id`); the tenants a person can reach come from `memberships`. This
 * interface is confined to exactly what the login/session service needs and is
 * used only by it, so both can be unit-tested against a fake with no database.
 *
 * It never accepts a tenant id from the caller and never returns a password hash
 * to anything but the in-process hasher via {@link AuthLoginRecord}.
 */

import { and, eq, sql } from 'drizzle-orm';

import type { AppDatabase } from '@/db/client.js';
import { memberships, passwordCredentials, tenants, users } from '@/db/schema.js';

/** One tenant a user is an *active* member of, with the role for that tenant. */
export interface AuthMembership {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly role: 'owner' | 'member';
}

/**
 * Everything the login flow needs about the account behind an email, resolved in
 * one shot: the identity, its current status, the stored password hash (or null
 * when the account has no credential), and the tenants the person is an active
 * member of (an active membership in an active tenant only). The password hash
 * rides along solely so the service can run the KDF; it is never surfaced beyond
 * that.
 */
export interface AuthLoginRecord {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly userStatus: 'active' | 'disabled';
  /** The Argon2id PHC hash, or null if the user has no password credential. */
  readonly passwordHash: string | null;
  /** Active memberships in active tenants; empty if the user can reach none. */
  readonly activeMemberships: readonly AuthMembership[];
}

/** The public identity of a user and one tenant — the safe fields a session exposes. */
export interface AuthProfile {
  readonly user: { readonly id: string; readonly email: string; readonly name: string | null };
  readonly tenant: { readonly id: string; readonly name: string };
}

/**
 * The minimal, storage-agnostic seam the auth service depends on. Emails passed
 * in are already normalised (trimmed, lower-cased) by the service; the query
 * still compares case-insensitively via `lower(email)` to match the unique index.
 */
export interface AuthUserStore {
  /** Resolve the account for a normalised email, or null if none exists. */
  findLoginByEmail(normalizedEmail: string): Promise<AuthLoginRecord | null>;
  /**
   * Resolve the safe public identity for an already-authenticated (user, tenant)
   * pair, or null if either side has vanished. Both ids come from a verified
   * session, never from request input.
   */
  findProfile(userId: string, tenantId: string): Promise<AuthProfile | null>;
}

/** Postgres-backed store. All lookups are by indexed key; none is tenant-scoped by design. */
export class DrizzleAuthUserStore implements AuthUserStore {
  constructor(private readonly db: AppDatabase) {}

  async findLoginByEmail(normalizedEmail: string): Promise<AuthLoginRecord | null> {
    // The identity + credential in one row. `lower(email)` matches the
    // `users_email_key` unique index, so "Bob@x.com" and "bob@x.com" are one
    // account. The LEFT JOIN keeps a credential-less user visible (passwordHash
    // null) rather than making them a distinct, enumerable "no such row" path.
    const rows = await this.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        userStatus: users.status,
        passwordHash: passwordCredentials.passwordHash,
      })
      .from(users)
      .leftJoin(passwordCredentials, eq(passwordCredentials.userId, users.id))
      .where(eq(sql`lower(${users.email})`, normalizedEmail))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;

    // Only active memberships in active tenants can ground a session; a suspended
    // tenant or a disabled membership yields no eligible tenant.
    const membershipRows = await this.db
      .select({
        tenantId: memberships.tenantId,
        tenantName: tenants.name,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(
        and(
          eq(memberships.userId, row.userId),
          eq(memberships.status, 'active'),
          eq(tenants.status, 'active'),
        ),
      );

    return {
      userId: row.userId,
      email: row.email,
      name: row.name,
      userStatus: row.userStatus,
      passwordHash: row.passwordHash,
      activeMemberships: membershipRows,
    };
  }

  async findProfile(userId: string, tenantId: string): Promise<AuthProfile | null> {
    // Re-resolve identity and tenant through the membership that binds them, so a
    // profile can only be built for a pair that is genuinely a membership — the
    // same pairing the session's composite FK guarantees. One indexed row.
    const rows = await this.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        tenantId: tenants.id,
        tenantName: tenants.name,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;

    return {
      user: { id: row.userId, email: row.email, name: row.name },
      tenant: { id: row.tenantId, name: row.tenantName },
    };
  }
}
