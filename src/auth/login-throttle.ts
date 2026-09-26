/**
 * Account-scoped login throttling — the durable complement to the process-local
 * per-IP rate limiter.
 *
 * The general limiter (`@fastify/rate-limit`, keyed by IP, in `app.ts`) is
 * in-memory. On the serverless targets this deploys to it is not shared across
 * instances, and even when it were it keys on IP — so it does nothing against a
 * password-guessing attacker who rotates IPs against *one* account. This throttle
 * closes that gap: it counts recent *failed* attempts against the submitted email
 * in Postgres (shared across instances) and refuses further attempts once the
 * account crosses a threshold, no matter which IPs they came from.
 *
 * Two properties are load-bearing for security:
 *   - it is keyed by the **submitted identifier**, recorded even for emails that
 *     do not exist, so a known and an unknown address are throttled identically —
 *     the throttle is never a user-existence oracle;
 *   - the service consults it *before* verifying a password and records a failure
 *     *after* a failed verification, so correct credentials cannot bypass it and
 *     it cannot be worn down for free.
 *
 * Tradeoff (documented): an attacker rotating IPs can still trip the throttle for
 * a victim's address, i.e. cause a temporary, self-healing lockout of that
 * account's password login. That is the standard cost of account-scoped
 * throttling; the window is short and clears on the next successful login, and
 * the alternative (no account-scoped limit) leaves offline-grade online guessing
 * open. No shared cache (e.g. Redis) is introduced — none exists in this stack —
 * so Postgres is the smallest correct shared store.
 */

import { and, eq, gt, lt, sql } from 'drizzle-orm';

import type { AppDatabase } from '@/db/client.js';
import { loginAttempts } from '@/db/schema.js';

/** The seam the auth service depends on, so it can be unit-tested against a fake. */
export interface LoginThrottle {
  /** True if this identifier has too many recent failed attempts to try again now. */
  isThrottled(identifier: string): Promise<boolean>;
  /** Record one failed attempt for this identifier. */
  recordFailure(identifier: string): Promise<void>;
  /** Forget this identifier's attempts (called on a successful login). */
  clear(identifier: string): Promise<void>;
}

/** Default policy: at most this many failed attempts within the window. */
export const DEFAULT_MAX_ATTEMPTS = 5;
/** Default policy: the rolling window, in milliseconds (15 minutes). */
export const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

export interface LoginThrottleOptions {
  readonly maxAttempts?: number;
  readonly windowMs?: number;
}

/** Postgres-backed throttle over the `login_attempts` table. */
export class DrizzleLoginThrottle implements LoginThrottle {
  private readonly maxAttempts: number;
  private readonly windowMs: number;

  constructor(private readonly db: AppDatabase, options: LoginThrottleOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  }

  private cutoff(): Date {
    return new Date(Date.now() - this.windowMs);
  }

  async isThrottled(identifier: string): Promise<boolean> {
    const [row] = await this.db
      .select({ attempts: sql<number>`cast(count(*) as int)` })
      .from(loginAttempts)
      .where(
        and(eq(loginAttempts.identifier, identifier), gt(loginAttempts.createdAt, this.cutoff())),
      );
    return (row?.attempts ?? 0) >= this.maxAttempts;
  }

  async recordFailure(identifier: string): Promise<void> {
    await this.db.insert(loginAttempts).values({ identifier });
    // Opportunistically drop this identifier's now-irrelevant rows so the table
    // stays bounded without a background reaper. Scoped to the one identifier so
    // it is a cheap index range delete, not a table scan.
    await this.db
      .delete(loginAttempts)
      .where(
        and(eq(loginAttempts.identifier, identifier), lt(loginAttempts.createdAt, this.cutoff())),
      );
  }

  async clear(identifier: string): Promise<void> {
    await this.db.delete(loginAttempts).where(eq(loginAttempts.identifier, identifier));
  }
}
