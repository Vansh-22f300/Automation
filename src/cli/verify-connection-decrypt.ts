/**
 * `verify-connection-decrypt` — a manual, READ-ONLY check that one connection's
 * stored credential still decrypts under the currently-configured keyring.
 *
 * It exists for the v2-keyring rollout: before enabling GitHub OAuth we must prove
 * that the existing (legacy v1) connection decrypts with the new
 * `CREDENTIAL_ENCRYPTION_KEYS` (whose `legacy-v1` entry must carry the original key
 * bytes). It reuses the rotation DRY-RUN decrypt path verbatim — so it makes NO
 * database writes, runs NO external (Slack/GitHub) request, and never rotates a key —
 * then reports only a sanitized PASS/FAIL.
 *
 * Why not trust a zero exit code: the targeted rotate dry-run is a quiet no-op for a
 * connection that is missing, in another tenant, or already on the active key — all
 * of which exit 0. So this tool PASSes only when the dry-run actually found the row
 * AND decrypted it (`wouldRotate === 1`); a no-op is a FAIL, not a pass.
 *
 * NEVER printed: the plaintext credential, the keyring, the DATABASE_URL, the
 * encrypted envelope, the connection name, or raw exception details. The only stdout
 * is one `RESULT: PASS|FAIL — <non-secret reason>` line.
 */

import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { runRotate } from '@/cli/connections-rotate.js';
import type { RunRotateSummary } from '@/cli/connections-rotate.js';
import { parseEnv } from '@/config/env.js';
import type { Env } from '@/config/env.js';
import { createDatabase } from '@/db/client.js';
import type { DatabaseHandle } from '@/db/client.js';
import { isAppError } from '@/domain/errors.js';
import { createLogger } from '@/observability/logger.js';
import type { Logger } from '@/observability/logger.js';
import { ConnectionRepository } from '@/repositories/connection-repository.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import { CredentialCipher, createCredentialCipher } from '@/security/credential-cipher.js';

/** The sanitized outcome. `reason` is an enumerated, non-secret token. */
export interface VerifyVerdict {
  readonly outcome: 'pass' | 'fail';
  readonly reason:
    | 'decrypted'
    | 'decrypt_failed'
    | 'not_found_or_already_current'
    | 'no_active_key';
  readonly exitCode: 0 | 1;
}

/** UUID shape (incl. UUIDv7). Both ids are validated before any DB access. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidId(value: string | undefined): value is string {
  return value !== undefined && UUID_RE.test(value);
}

/**
 * Map a targeted dry-run summary to a verdict. `wouldRotate === 1` means the row was
 * found and decrypted; `wouldFail > 0` means found-but-undecryptable; both zero means
 * the dry-run was a no-op (missing / wrong tenant / already current) — never a PASS.
 */
export function mapSummaryToVerdict(
  summary: Pick<RunRotateSummary, 'wouldRotate' | 'wouldFail'>,
): VerifyVerdict {
  if (summary.wouldFail > 0) return { outcome: 'fail', reason: 'decrypt_failed', exitCode: 1 };
  if (summary.wouldRotate === 1) return { outcome: 'pass', reason: 'decrypted', exitCode: 0 };
  return { outcome: 'fail', reason: 'not_found_or_already_current', exitCode: 1 };
}

/** Non-secret, operator-readable line per reason. Never includes ids/names/values. */
const MESSAGES: Record<VerifyVerdict['reason'], string> = {
  decrypted: 'the connection was found and its credential decrypted under the current keyring.',
  decrypt_failed: 'the connection was found but its credential did NOT decrypt under the current keyring.',
  not_found_or_already_current:
    'the connection was not found in this tenant (check the ids), or is already on the active key, so the dry-run could not verify a decrypt.',
  no_active_key: 'no active v2 key is configured (CREDENTIAL_ENCRYPTION_KEYS); there is nothing to verify against.',
};

function writeVerdict(out: NodeJS.WritableStream, verdict: VerifyVerdict): void {
  out.write(`RESULT: ${verdict.outcome.toUpperCase()} — ${MESSAGES[verdict.reason]}\n`);
}

/** A sink that discards everything — used to swallow the dry-run's name-bearing lines. */
function nullSink(): NodeJS.WritableStream {
  return new Writable({ write(_chunk, _enc, cb) { cb(); } });
}

export interface VerifyDecryptOptions {
  readonly repository: ConnectionRepository;
  readonly cipher: CredentialCipher;
  readonly tenantId: string;
  readonly connectionId: string;
  /** Where the single sanitized RESULT line goes. Defaults to process.stdout. */
  readonly stdout?: NodeJS.WritableStream;
}

/**
 * Verify one connection decrypts, reusing the rotation dry-run (no DB writes, no
 * external calls). Emits exactly one sanitized RESULT line and returns the verdict.
 */
export async function runVerifyDecrypt(options: VerifyDecryptOptions): Promise<VerifyVerdict> {
  const out = options.stdout ?? process.stdout;
  const activeKid = options.cipher.ring.activeKid;
  if (activeKid === null) {
    const verdict: VerifyVerdict = { outcome: 'fail', reason: 'no_active_key', exitCode: 1 };
    writeVerdict(out, verdict);
    return verdict;
  }
  const summary = await runRotate({
    repository: options.repository,
    cipher: options.cipher,
    tenantId: options.tenantId,
    activeKid,
    connectionId: options.connectionId,
    dryRun: true,
    batchSize: 100,
    stdout: nullSink(),
  });
  const verdict = mapSummaryToVerdict(summary);
  writeVerdict(out, verdict);
  return verdict;
}

/**
 * Process-level dependencies, injected so the initialization-failure paths are
 * testable without a real environment, database, or keyring. The defaults wire the
 * real factories; tests pass fakes that throw at a chosen stage.
 */
export interface VerifyCliDeps {
  readonly loadEnv: () => Env;
  readonly createLogger: (env: Env) => Logger;
  readonly createCipher: (env: Env, logger: Logger) => CredentialCipher;
  readonly createDatabase: (env: Env, logger: Logger) => DatabaseHandle;
}

const DEFAULT_DEPS: VerifyCliDeps = {
  // parseEnv, not loadEnv: loadEnv calls process.exit(1) on a config error, which would
  // bypass the guard in runCli; parseEnv throws instead, so an environment failure flows
  // through the guard and yields the single sanitized RESULT: FAIL line like every other
  // stage. The thrown EnvValidationError lists variable names + shape messages, never
  // values — and runCli never prints or logs it anyway.
  loadEnv: () => parseEnv(),
  createLogger: (env) => createLogger(env, { service: 'cli' }),
  createCipher: (env, logger) => createCredentialCipher(env, { logger }),
  createDatabase: (env, logger) => createDatabase(env, logger, { service: 'cli' }),
};

/** Where the CLI reads its args and writes its output. Injectable for tests. */
export interface VerifyCliIo {
  /** The two positional args — [tenantId, connectionId] (i.e. process.argv.slice(2)). */
  readonly argv: readonly string[];
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

/**
 * Run the CLI end to end and return its exit code (never throws).
 *
 * EVERY step — env load, logger/cipher/database construction, the verify itself, and
 * cleanup — runs inside one guard, so no raw exception (a DB host from a connect
 * failure, a keyring parse detail, a stack trace) can escape to the Actions log. On
 * any failure it logs at most a typed, non-secret code, prints exactly one sanitized
 * `RESULT: FAIL` line, and returns 1. A database handle, once constructed, is always
 * closed; a failure while closing is swallowed so it can neither replace the verdict
 * nor leak a detail of its own.
 */
export async function runCli(
  io: VerifyCliIo,
  deps: VerifyCliDeps = DEFAULT_DEPS,
): Promise<0 | 1> {
  const tenantId = io.argv[0];
  const connectionId = io.argv[1];
  if (!isValidId(tenantId) || !isValidId(connectionId)) {
    io.stderr.write('usage: verify-connection-decrypt <tenantId:uuid> <connectionId:uuid>\n');
    return 1;
  }

  let database: DatabaseHandle | undefined;
  let logger: Logger | undefined;
  try {
    const env = deps.loadEnv();
    logger = deps.createLogger(env);
    // Build the cipher before opening a pool: a malformed keyring is the most likely
    // initialization failure during a rollout, and failing here leaves no database
    // handle to clean up.
    const cipher = deps.createCipher(env, logger);
    database = deps.createDatabase(env, logger);
    await database.verifyConnection();
    const repository = new ConnectionRepository(new TenantScope(database.db, tenantId), cipher);
    const verdict = await runVerifyDecrypt({
      repository,
      cipher,
      tenantId,
      connectionId,
      stdout: io.stdout,
    });
    return verdict.exitCode;
  } catch (error) {
    // Never surface raw exception detail. Log a typed code only — and only if the
    // logger was constructed — then print one generic, sanitized failure line.
    if (logger !== undefined) {
      logger.error(
        { event: 'verify_connection_decrypt_error', code: isAppError(error) ? error.code : 'unknown' },
        'verify_connection_decrypt_error',
      );
    }
    io.stdout.write('RESULT: FAIL — verification could not run (see run logs for a non-secret error code).\n');
    return 1;
  } finally {
    if (database !== undefined) {
      try {
        await database.close();
      } catch {
        // A cleanup failure must neither replace the verdict nor leak a raw detail.
      }
    }
  }
}

async function main(): Promise<void> {
  // LOG_LEVEL is expected to be `silent` in the manual workflow, so the only output
  // is the RESULT line; the logger carries at most a typed, non-secret error code.
  process.exitCode = await runCli({
    argv: process.argv.slice(2),
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

// Run `main` only when executed directly, so tests can import the pure helpers above
// without triggering env loading or a database connection.
const invokedPath = process.argv[1];
const isEntrypoint = invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href;
if (isEntrypoint) {
  await main();
}
