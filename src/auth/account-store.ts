/**
 * Account creation for self-serve signup — the write-side counterpart to the
 * tenant-blind, read-side `@/auth/auth-user-store`.
 *
 * Signup is the one operation that must bring a whole ownership chain into
 * existence at once: a brand-new workspace (`tenants`), a global person
 * (`users`), their password (`password_credentials`), their `owner` membership
 * (`memberships`), their first live session (`sessions`), and a first
 * email-verification token (`auth_tokens`). Either *all* of
 * that commits or *none* of it does — a half-made account (a user with no
 * membership, a workspace with no owner) would be a security and support
 * hazard. So unlike the other auth stores, which each touch a single table on
 * `this.db`, this seam owns one `db.transaction(...)` spanning all six inserts.
 *
 * The expensive, non-transactional work — the Argon2id password hash and the
 * CSPRNG session token — is done by the caller (`AuthService.signup`) *before*
 * the transaction opens, so the slow KDF never holds a connection or row locks.
 * This store receives only the finished `passwordHash` and `tokenHash`; it never
 * sees a plaintext password or the raw token.
 *
 * Duplicate email is handled race-free: there is no read-then-write pre-check
 * (which two concurrent signups could both pass). The insert simply runs, and
 * the global `users_email_key` unique index rejects the second writer with
 * SQLSTATE `23505`; that specific violation — and only that one — is translated
 * into {@link EmailAlreadyRegisteredError}. Any other constraint violation
 * (e.g. the astronomically unlikely session-token-hash collision) is rethrown
 * unchanged rather than masked as an email conflict.
 */

import { authTokens, memberships, passwordCredentials, sessions, tenants, users } from '@/db/schema.js';
import type { AppDatabase } from '@/db/client.js';

/** All server-derived; the caller normalises the email and hashes the secrets. */
export interface CreateOwnerAccountInput {
  /** Already normalised (trimmed + lower-cased) by the caller. */
  readonly email: string;
  /** Display name, or null when none was given. */
  readonly name: string | null;
  /** Argon2id PHC string, hashed *outside* the transaction. */
  readonly passwordHash: string;
  /** The new workspace's display name (trimmed by the caller). */
  readonly workspaceName: string;
  /** SHA-256 digest of the opaque session token; the plaintext is never stored. */
  readonly tokenHash: string;
  /** Absolute session expiry, computed by the caller. */
  readonly expiresAt: Date;
  /** SHA-256 digest of the opaque email-verification token; plaintext never stored. */
  readonly verificationTokenHash: string;
  /** Absolute expiry of the verification token, computed by the caller. */
  readonly verificationExpiresAt: Date;
}

/** The safe identity of the account just created — no secret material. */
export interface CreatedAccount {
  readonly user: { readonly id: string; readonly email: string; readonly name: string | null };
  readonly tenant: { readonly id: string; readonly name: string };
}

/**
 * The storage-agnostic seam `AuthService.signup` depends on, so the use-case can
 * be unit-tested against an in-memory fake with no database.
 */
export interface AccountStore {
  /**
   * Create a workspace, its owner, their credential, and their first session in
   * a single transaction. Rejects with {@link EmailAlreadyRegisteredError} when
   * the email is already registered; every other failure rolls the whole thing
   * back and propagates.
   */
  createOwnerAccount(input: CreateOwnerAccountInput): Promise<CreatedAccount>;
}

/**
 * Thrown when signup collides with an already-registered email. A semantic
 * domain error, deliberately not an HTTP error: the framework-free service maps
 * it to a closed result and the route renders the generic 409, so nothing about
 * the existing account (name, workspaces, role) can leak.
 */
export class EmailAlreadyRegisteredError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('An account with that email already exists', options);
    this.name = 'EmailAlreadyRegisteredError';
  }
}

/**
 * Is this error the `users_email_key` unique violation, and only that?
 *
 * drizzle-orm (0.45.x) wraps the original `pg` error on `.cause`; older paths
 * threw it directly. Walk the cause chain (bounded) looking for the pg error
 * that carries both SQLSTATE `23505` on `.code` and the offending index name on
 * `.constraint`. Requiring the constraint name means a different `23505` (a
 * future constraint, or a session-token-hash collision) is *not* misreported as
 * an email conflict — it falls through and is rethrown.
 */
function isEmailUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    const e = current as { readonly code?: unknown; readonly constraint?: unknown; readonly cause?: unknown };
    if (e.code === '23505' && e.constraint === 'users_email_key') {
      return true;
    }
    current = e.cause;
  }
  return false;
}

/**
 * Postgres-backed account creation. One transaction, six inserts, in foreign-key
 * order so every row's references already exist when it is written:
 *
 *   tenants → users → password_credentials → memberships → sessions → auth_tokens
 *
 * The `owner` membership must precede the session, because the composite FK
 * `sessions(tenant_id, user_id) → memberships(tenant_id, user_id)` makes a
 * session for a non-member unrepresentable. Any failure at any step aborts the
 * transaction, so no partial account can survive.
 */
export class DrizzleAccountStore implements AccountStore {
  constructor(private readonly db: AppDatabase) {}

  async createOwnerAccount(input: CreateOwnerAccountInput): Promise<CreatedAccount> {
    try {
      return await this.db.transaction(async (tx) => {
        // The new workspace. Created first; if the user insert below rejects a
        // duplicate email, this row is rolled back with the rest — no orphan
        // workspace is left behind.
        const [tenant] = await tx
          .insert(tenants)
          .values({ name: input.workspaceName })
          .returning({ id: tenants.id, name: tenants.name });
        const createdTenant = tenant!;

        // The global person. This is where a duplicate email fails, via the
        // `users_email_key` unique index — never a racy pre-check.
        const [user] = await tx
          .insert(users)
          .values({ email: input.email, name: input.name, status: 'active' })
          .returning({ id: users.id, email: users.email, name: users.name });
        const createdUser = user!;

        await tx.insert(passwordCredentials).values({
          userId: createdUser.id,
          passwordHash: input.passwordHash,
        });

        // The signing-up user owns the workspace they just created.
        await tx.insert(memberships).values({
          tenantId: createdTenant.id,
          userId: createdUser.id,
          role: 'owner',
          status: 'active',
        });

        // Their first session — minted inside the same transaction, so a
        // successful signup returns an immediately usable credential.
        await tx.insert(sessions).values({
          tenantId: createdTenant.id,
          userId: createdUser.id,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        });

        // The email-verification token, minted in the same transaction so a new
        // account always has exactly one live verification token from the moment
        // it exists. Only the hash is stored; the plaintext rides out only in the
        // emailed link (built by the notifier), never persisted or returned here.
        await tx.insert(authTokens).values({
          userId: createdUser.id,
          purpose: 'email_verification',
          tokenHash: input.verificationTokenHash,
          expiresAt: input.verificationExpiresAt,
        });

        return {
          user: { id: createdUser.id, email: createdUser.email, name: createdUser.name },
          tenant: { id: createdTenant.id, name: createdTenant.name },
        };
      });
    } catch (error) {
      if (isEmailUniqueViolation(error)) {
        throw new EmailAlreadyRegisteredError({ cause: error });
      }
      throw error;
    }
  }
}
