/**
 * Shared support for the PostgreSQL integration suites.
 *
 * Centralises the three things every integration file needs and must agree on:
 *   - the TEST_DATABASE_URL gate (read once, here);
 *   - the safety guard that refuses any database whose name lacks "test", so a
 *     suite that writes and deletes rows can never be pointed at DATABASE_URL;
 *   - a handle factory that feeds the test URL in as its own DATABASE_URL, so
 *     the suites never depend on the ambient development connection.
 *
 * Schema creation is NOT done here — `global-setup.ts` migrates the test
 * database exactly once per run. Suites only connect and seed.
 */

import { parseEnv } from '@/config/env.js';
import { createDatabase, describeDatabaseUrl } from '@/db/client.js';
import type { DatabaseHandle } from '@/db/client.js';
import { createLogger } from '@/observability/logger.js';
import type { AccountRecoveryService } from '@/auth/account-recovery-service.js';

/** The gate every integration `describe.skipIf(...)` reads. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * Refuse to run destructive integration tests against anything but a test
 * database. The single authoritative guard — do not inline a copy elsewhere.
 */
export function assertTestDatabase(url: string): void {
  const target = describeDatabaseUrl(url);
  if (!target.database.includes('test')) {
    throw new Error(
      `Refusing to run integration tests against database "${target.database}": ` +
        'these tests write and delete rows. Point TEST_DATABASE_URL at a database ' +
        'whose name contains "test".',
    );
  }
}

/**
 * Build an isolated database handle bound to TEST_DATABASE_URL, after the guard.
 * Only call from a `beforeAll` reached under `skipIf(TEST_DATABASE_URL === undefined)`.
 */
export function createTestDatabaseHandle(): DatabaseHandle {
  const url = TEST_DATABASE_URL as string;
  assertTestDatabase(url);
  const env = parseEnv({ DATABASE_URL: url, LOG_LEVEL: 'silent' });
  return createDatabase(env, createLogger(env, { service: 'test' }), {
    service: 'test',
    statementTimeoutMs: 60_000,
  });
}

/**
 * Extract a PostgreSQL SQLSTATE from a thrown error.
 *
 * drizzle-orm (0.45.x) wraps query failures in a `DrizzleQueryError` whose
 * original `pg` error — the one carrying the five-character SQLSTATE on `.code`
 * — is on `.cause`. Older paths threw the `pg` error directly. Walk the cause
 * chain so both shapes yield the code; return undefined only when there truly
 * is no SQLSTATE (so tests can assert on 23505/23503 rather than accept
 * undefined).
 */
export function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current != null; depth += 1) {
    const code = (current as { readonly code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * A fail-closed `AccountRecoveryService` stand-in for suites that assemble the
 * full app but never drive the recovery routes (login/logout, signup, the
 * data-plane). Every use-case throws if reached, so it can only satisfy
 * `buildApp`'s dependency set — never quietly service a request. Suites that
 * actually exercise verification/recovery construct the real service instead.
 */
export function inertAccountRecovery(): AccountRecoveryService {
  return {
    requestPasswordReset: async () => {
      throw new Error('not used');
    },
    resetPassword: async () => {
      throw new Error('not used');
    },
    verifyEmail: async () => {
      throw new Error('not used');
    },
    resendVerification: async () => {
      throw new Error('not used');
    },
  } as unknown as AccountRecoveryService;
}

/**
 * Re-exported from the unit stubs (single source of truth): a fail-closed
 * `OAuthService` stand-in for full-app suites that never drive the OAuth routes.
 * `buildApp` always registers those routes, so every assembling suite must supply
 * an `oauthService`; this one throws if any use-case is reached.
 */
export { inertOAuthService } from '../unit/human-auth-stubs.js';
