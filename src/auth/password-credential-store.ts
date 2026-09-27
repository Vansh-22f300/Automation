/**
 * Password-credential persistence — the narrow write seam that lets a password
 * *reset* replace a user's stored hash without duplicating any hashing logic.
 *
 * There is exactly one credential row per user (`password_credentials` carries a
 * unique `password_credentials_user_id_key` on `user_id`). Signup creates it
 * (see `@/auth/account-store`); this store is how the recovery flow overwrites
 * it. It deals only in an already-computed Argon2id PHC string — the slow KDF
 * runs in the service *before* any transaction opens, so a reset never holds a
 * connection while hashing. This module never sees, logs, or returns a plaintext
 * password.
 *
 * {@link Executor}-aware so `replace` can run inside the reset transaction that
 * also consumes the reset token and revokes the user's sessions — all three
 * commit together or not at all.
 */

import { sql } from 'drizzle-orm';

import type { AppDatabase, Executor } from '@/db/client.js';
import { passwordCredentials } from '@/db/schema.js';

/**
 * The minimal, storage-agnostic seam the recovery service depends on, so the
 * use-case can be unit-tested against an in-memory fake with no database.
 */
export interface PasswordCredentialStore {
  /**
   * Set (or replace) the password hash for a user. Upsert semantics: creates the
   * row if somehow absent, otherwise overwrites the hash and bumps `updated_at`.
   * The `userId` is server-derived (it comes from a just-consumed reset token),
   * never from request input.
   */
  replace(userId: string, passwordHash: string, executor?: Executor): Promise<void>;
}

/** Postgres-backed store. Upserts on the unique `password_credentials_user_id_key`. */
export class DrizzlePasswordCredentialStore implements PasswordCredentialStore {
  constructor(private readonly db: AppDatabase) {}

  async replace(
    userId: string,
    passwordHash: string,
    executor: Executor = this.db,
  ): Promise<void> {
    // Upsert rather than update: a reset must succeed even for the (unexpected)
    // case of a user with no existing credential row, and it must be a single
    // race-safe statement. The conflict target is the unique `user_id` index, so
    // a concurrent reset resolves to one final hash rather than a duplicate row.
    await executor
      .insert(passwordCredentials)
      .values({ userId, passwordHash })
      .onConflictDoUpdate({
        target: passwordCredentials.userId,
        set: { passwordHash, updatedAt: sql`now()` },
      });
  }
}
