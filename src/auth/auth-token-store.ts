/**
 * Persistence for the email auth tokens (verification + password reset) — the
 * write/consume counterpart to the pure `@/auth/auth-token` primitives.
 *
 * Unlike the three tenant-blind *authentication* stores (`api-key-store`,
 * `session-store`, `auth-user-store`), this is not an authentication path: a
 * token here is consumed by a person who is proving control of an email or
 * completing a reset, and the row itself names the user. It carries no
 * `tenant_id` — an `auth_tokens` row is about a global `users` identity, not a
 * workspace — so nothing here is tenant-scoped, by design of the schema.
 *
 * Every method is {@link Executor}-aware (accepts either the pool or an open
 * transaction, defaulting to the pool) so a reset can consume the token, replace
 * the credential and revoke sessions inside one transaction — the same seam the
 * job queue uses to enqueue inside the ingestion transaction.
 *
 * The security-critical method is {@link AuthTokenStore.consume}: it is the
 * single-use gate. It flips `consumed_at` and returns the owning user in one
 * atomic `UPDATE … WHERE consumed_at IS NULL AND expires_at > now() RETURNING`,
 * so two concurrent redemptions of the same token cannot both win — exactly one
 * row update returns, the loser sees zero rows and gets `null`. Expiry is judged
 * by Postgres (`now()`), never the app clock.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';

import type { AppDatabase, Executor } from '@/db/client.js';
import { authTokens } from '@/db/schema.js';

/** The two kinds of email token; mirrors the `auth_token_purpose` enum. */
export type AuthTokenPurpose = 'email_verification' | 'password_reset';

/** The fields required to persist a new token. All server-derived. */
export interface NewAuthTokenInput {
  readonly userId: string;
  readonly purpose: AuthTokenPurpose;
  /** SHA-256 digest of the opaque token; the plaintext is never stored. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/** Identifies a specific token to spend: its hash *and* the purpose it must be. */
export interface ConsumeAuthTokenInput {
  readonly tokenHash: string;
  /**
   * The purpose the token must have. Requiring it means a verification token can
   * never be redeemed on the reset path (or vice versa), even though both live
   * in one table — the purpose is part of the match, not just a label.
   */
  readonly purpose: AuthTokenPurpose;
}

/** Identifies a user's live tokens of one purpose, for bulk invalidation. */
export interface InvalidateAuthTokensInput {
  readonly userId: string;
  readonly purpose: AuthTokenPurpose;
}

/**
 * The minimal, storage-agnostic seam the recovery service depends on, so the
 * use-case can be unit-tested against an in-memory fake with no database.
 */
export interface AuthTokenStore {
  /** Persist a new token. Optionally inside a caller's transaction. */
  create(input: NewAuthTokenInput, executor?: Executor): Promise<void>;
  /**
   * Atomically spend a token: mark it consumed and return its user, but only if
   * it exists, matches the purpose, is unconsumed, and is unexpired. Returns
   * null in every other case without distinguishing them (unknown / wrong
   * purpose / already spent / expired), so a caller cannot probe which it was.
   * Single-use is guaranteed by the conditional update: a second redemption
   * matches no row.
   */
  consume(input: ConsumeAuthTokenInput, executor?: Executor): Promise<{ userId: string } | null>;
  /**
   * Consume (invalidate) every still-live token of one purpose for a user, so a
   * freshly issued token supersedes any earlier ones. Idempotent; a no-op when
   * the user has none outstanding.
   */
  invalidateActiveForUser(input: InvalidateAuthTokensInput, executor?: Executor): Promise<void>;
}

/**
 * Postgres-backed store. `create`/lookup hit the unique `auth_tokens_token_hash_key`
 * index; the per-user invalidation uses `auth_tokens_user_id_purpose_idx`.
 */
export class DrizzleAuthTokenStore implements AuthTokenStore {
  constructor(private readonly db: AppDatabase) {}

  async create(input: NewAuthTokenInput, executor: Executor = this.db): Promise<void> {
    await executor.insert(authTokens).values({
      userId: input.userId,
      purpose: input.purpose,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    });
  }

  async consume(
    input: ConsumeAuthTokenInput,
    executor: Executor = this.db,
  ): Promise<{ userId: string } | null> {
    // The whole single-use contract is this one statement. The WHERE clause is
    // the guard (right hash, right purpose, not yet consumed, not expired) and
    // RETURNING makes the winning update also the read of the owning user. Two
    // racing consumers cannot both match the `consumed_at IS NULL` predicate on
    // the same row — the first commits `consumed_at = now()`, the second updates
    // nothing and gets an empty set. `now()` is Postgres' clock, so expiry never
    // depends on the app server's time.
    const rows = await executor
      .update(authTokens)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(authTokens.tokenHash, input.tokenHash),
          eq(authTokens.purpose, input.purpose),
          isNull(authTokens.consumedAt),
          sql`${authTokens.expiresAt} > now()`,
        ),
      )
      .returning({ userId: authTokens.userId });

    return rows[0] ?? null;
  }

  async invalidateActiveForUser(
    input: InvalidateAuthTokensInput,
    executor: Executor = this.db,
  ): Promise<void> {
    // Retire any outstanding tokens of this purpose so only the newest is live.
    // Guarded on `consumed_at IS NULL` so an already-spent token keeps its
    // original consumption time. Expired-but-unconsumed rows are harmlessly
    // stamped too; they were already unusable via the `consume` expiry check.
    await executor
      .update(authTokens)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(authTokens.userId, input.userId),
          eq(authTokens.purpose, input.purpose),
          isNull(authTokens.consumedAt),
        ),
      );
  }
}
