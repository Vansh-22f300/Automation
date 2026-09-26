/**
 * Session persistence for authentication — the session counterpart to
 * `@/auth/api-key-store`, and the second (and only other) deliberately
 * tenant-blind data path in the system.
 *
 * A request presents a session token *in order to discover which tenant and
 * user it belongs to*, so the authenticating lookup cannot itself be scoped to a
 * tenant — the tenant is the row's answer, never the caller's input. This is the
 * same chicken-and-egg exception `DrizzleApiKeyStore` documents, confined here to
 * a narrow interface used only by the session authenticator. It lives under
 * `src/auth/` rather than `src/repositories/` precisely because it is that
 * pre-tenant path, not an ordinary tenant-scoped repository.
 *
 * The lookup returns the tenant/user the token's row is bound to; it never
 * accepts a tenant id from the caller. The composite foreign key
 * `sessions(tenant_id, user_id) → memberships(tenant_id, user_id)` guarantees a
 * session can only exist for a real membership, so the inner join always
 * resolves and the pair is trustworthy. The mutating methods (`create`,
 * `revoke`, `revokeAllForUser`) take their identifiers from already-established
 * server-side state (a future login/logout service), never from request data.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';

import type { AppDatabase } from '@/db/client.js';
import { memberships, sessions } from '@/db/schema.js';

/**
 * Everything authentication needs about a live session — and no more. The
 * membership `status`/`role` ride along so the authenticator can enforce that the
 * person is still an active member without a second query; the token hash itself
 * is never returned.
 */
export interface AuthSessionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly membershipStatus: 'active' | 'disabled';
  readonly membershipRole: 'owner' | 'member';
}

/** The fields required to persist a new session. All server-derived, never client input. */
export interface NewSessionInput {
  readonly tenantId: string;
  readonly userId: string;
  /** SHA-256 digest of the opaque token; the plaintext is never stored. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/**
 * The minimal, storage-agnostic seam the authenticator (and a future
 * login/logout service) depend on, so both can be unit-tested against a fake.
 */
export interface SessionStore {
  /** Persist a new session; returns its generated id. */
  create(input: NewSessionInput): Promise<{ id: string }>;
  /**
   * Resolve the *live* session for a token hash: existing, not revoked, not
   * expired. Returns null for every other case (unknown / revoked / expired)
   * without distinguishing them — the caller must not be able to tell which.
   */
  findActiveByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null>;
  /** Revoke the session for a token hash (logout). Idempotent. */
  revoke(tokenHash: string): Promise<void>;
  /** Revoke every live session for one member of one tenant. */
  revokeAllForUser(tenantId: string, userId: string): Promise<void>;
}

/** Postgres-backed store. The token-hash lookup hits the unique `sessions_token_hash_key` index. */
export class DrizzleSessionStore implements SessionStore {
  constructor(private readonly db: AppDatabase) {}

  async create(input: NewSessionInput): Promise<{ id: string }> {
    // The composite FK to `memberships` makes an unbacked (tenant, user) pair
    // unrepresentable — insert fails rather than creating an orphan session.
    const [row] = await this.db
      .insert(sessions)
      .values({
        tenantId: input.tenantId,
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      })
      .returning({ id: sessions.id });
    return { id: row!.id };
  }

  async findActiveByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null> {
    // INTENTIONALLY UNSCOPED (see this file's header): the pre-tenant discovery
    // lookup. The token *is* the credential that resolves the tenant, so no
    // tenant predicate can precede it — and one taken from the caller would be
    // unsafe. We match on the unique token hash alone; the tenant/user come
    // *out* of the joined row, never in. This is the session counterpart to
    // `DrizzleApiKeyStore.findByPrefix`, and is quarantined the same way — the
    // "bare-db auth exception" guard in tenant-isolation-architecture.test.ts
    // confines it to the session-authenticator seam.
    //
    // `now()` is evaluated by Postgres (transaction time), so expiry does not
    // depend on the app server's clock. The join is guaranteed by the composite
    // FK; membership status/role come back for the authenticator to judge.
    const rows = await this.db
      .select({
        id: sessions.id,
        tenantId: sessions.tenantId,
        userId: sessions.userId,
        expiresAt: sessions.expiresAt,
        membershipStatus: memberships.status,
        membershipRole: memberships.role,
      })
      .from(sessions)
      .innerJoin(
        memberships,
        and(
          eq(memberships.tenantId, sessions.tenantId),
          eq(memberships.userId, sessions.userId),
        ),
      )
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          sql`${sessions.expiresAt} > now()`,
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  async revoke(tokenHash: string): Promise<void> {
    // Guard on `revoked_at IS NULL` so a repeat logout does not overwrite the
    // original revocation time; revoking an unknown/already-revoked token is a
    // silent no-op.
    await this.db
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));
  }

  async revokeAllForUser(tenantId: string, userId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(sessions.tenantId, tenantId),
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
        ),
      );
  }
}
