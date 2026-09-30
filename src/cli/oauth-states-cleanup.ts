/**
 * `pnpm oauth:states:cleanup` — operator CLI for `oauth_states` retention
 * (state design §6). It removes only DEAD rows — those already consumed, or past
 * their (short) expiry — in bounded batches, and can NEVER touch a live unexpired
 * state: the predicate lives in {@link DrizzleOAuthStateStore.deleteExpiredAndConsumed},
 * which targets `consumed_at IS NOT NULL OR expires_at <= now()` under a LIMIT.
 *
 * This is deliberately not a background subsystem: `oauth_states` rows live for
 * minutes, so an occasional cron invocation of this CLI is enough. It is unscoped
 * by design — the table carries no tenant-visible data a tenant could enumerate,
 * and the callback that writes it is unauthenticated — so there is no tenant
 * argument; cleanup is a global janitorial sweep of expired/spent handshake rows.
 *
 *   pnpm oauth:states:cleanup [--batch-size <N>] [--drain]
 *
 *     --batch-size <N>   rows removed per statement (default 5000, max 50000).
 *     --drain            keep deleting batches until one comes back empty
 *                        (bounded by an internal safety cap on iterations).
 *
 * Exit codes: 0 on success (deleted may be 0 — nothing to do); 2 on a bad
 * argument or boot-time misconfiguration.
 */

import { pathToFileURL } from 'node:url';

import { loadEnv } from '@/config/env.js';
import { createDatabase } from '@/db/client.js';
import { createLogger } from '@/observability/logger.js';
import { createOAuthStateSecretBox } from '@/oauth/state-secret-box.js';
import { DrizzleOAuthStateStore } from '@/repositories/oauth-state-repository.js';
import { createCredentialCipher } from '@/security/credential-cipher.js';

/** Upper bound on a single batch — keeps one statement bounded and quick. */
export const MAX_CLEANUP_BATCH = 50_000;
/** Safety cap on `--drain` iterations so the loop is always finite. */
const MAX_DRAIN_ITERATIONS = 10_000;

/** A user-facing CLI argument problem (not a runtime exception). */
export class CliArgumentError extends Error {
  readonly code = 'cli_argument_invalid';
  constructor(message: string) {
    super(message);
    this.name = 'CliArgumentError';
  }
}

export interface ParsedArgs {
  readonly batchSize: number | undefined;
  readonly drain: boolean;
}

/** Parse `--batch-size <N>`; reject non-integers and anything outside [1, MAX]. */
export function parseBatchSize(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CLEANUP_BATCH) {
    throw new CliArgumentError(
      `--batch-size must be an integer in [1, ${MAX_CLEANUP_BATCH}]; got "${raw}"`,
    );
  }
  return n;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      throw new CliArgumentError(`unexpected argument "${a}"`);
    }
    const eq = a.indexOf('=');
    if (eq !== -1) {
      flags.set(a.slice(0, eq), a.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(a, next);
      i++;
    } else {
      flags.set(a, true);
    }
  }
  const rawBatch = flags.get('--batch-size');
  const batchSize = parseBatchSize(rawBatch === true ? undefined : rawBatch);
  return { batchSize, drain: flags.has('--drain') };
}

/** Options for {@link runCleanup}. */
export interface RunCleanupOptions {
  readonly store: Pick<DrizzleOAuthStateStore, 'deleteExpiredAndConsumed'>;
  readonly batchSize: number | undefined;
  readonly drain: boolean;
}

/**
 * Delete dead rows. In single-batch mode (default) one bounded delete runs; in
 * `--drain` mode batches repeat until one removes nothing (or the safety cap is
 * hit). Returns the total removed. The store guarantees only dead rows match.
 */
export async function runCleanup(options: RunCleanupOptions): Promise<number> {
  const batchOpts = options.batchSize !== undefined ? { limit: options.batchSize } : {};
  if (!options.drain) {
    return options.store.deleteExpiredAndConsumed(batchOpts);
  }
  let total = 0;
  for (let i = 0; i < MAX_DRAIN_ITERATIONS; i++) {
    const removed = await options.store.deleteExpiredAndConsumed(batchOpts);
    total += removed;
    if (removed === 0) break;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Entry point (process wiring). Kept tiny so the logic above stays testable.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliArgumentError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }

  const env = loadEnv();
  const logger = createLogger(env, { service: 'oauth-states-cleanup' });
  const database = createDatabase(env, logger, { service: 'oauth-states-cleanup' });
  const cipher = createCredentialCipher(env, { logger });

  try {
    await database.verifyConnection();
    const store = new DrizzleOAuthStateStore(database.db, createOAuthStateSecretBox(cipher));
    const deleted = await runCleanup({ store, batchSize: parsed.batchSize, drain: parsed.drain });
    logger.info({ event: 'oauth_states_cleanup_completed', deleted }, 'oauth_states_cleanup_completed');
    process.stdout.write(`oauth_states cleanup: removed ${deleted} dead row(s)\n`);
    process.exitCode = 0;
  } catch (error) {
    logger.fatal({ err: error }, 'oauth:states:cleanup failed');
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}

// Only invoke when this file is the process entry; vitest imports the symbols
// above directly and must not trigger a DB connection or a process exit.
const invokedAsEntry = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (invokedAsEntry) {
  void main();
}
