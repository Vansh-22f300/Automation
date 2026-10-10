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
import { loadEnv } from '@/config/env.js';
import { createDatabase } from '@/db/client.js';
import { isAppError } from '@/domain/errors.js';
import { createLogger } from '@/observability/logger.js';
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

async function main(): Promise<void> {
  const tenantId = process.argv[2];
  const connectionId = process.argv[3];
  if (!isValidId(tenantId) || !isValidId(connectionId)) {
    process.stderr.write('usage: verify-connection-decrypt <tenantId:uuid> <connectionId:uuid>\n');
    process.exitCode = 1;
    return;
  }
  // LOG_LEVEL is expected to be `silent` in the manual workflow, so the only output is
  // the RESULT line; the logger carries at most a typed, non-secret error code.
  const env = loadEnv();
  const logger = createLogger(env, { service: 'cli' });
  const database = createDatabase(env, logger, { service: 'cli' });
  const cipher = createCredentialCipher(env, { logger });
  try {
    await database.verifyConnection();
    const repository = new ConnectionRepository(new TenantScope(database.db, tenantId), cipher);
    const verdict = await runVerifyDecrypt({ repository, cipher, tenantId, connectionId });
    process.exitCode = verdict.exitCode;
  } catch (error) {
    // Never surface raw exception detail (it may carry a host/DB string). Log a typed
    // code only, and print one generic, sanitized failure line.
    logger.error(
      { event: 'verify_connection_decrypt_error', code: isAppError(error) ? error.code : 'unknown' },
      'verify_connection_decrypt_error',
    );
    process.stdout.write('RESULT: FAIL — verification could not run (see run logs for a non-secret error code).\n');
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}

// Run `main` only when executed directly, so tests can import the pure helpers above
// without triggering env loading or a database connection.
const invokedPath = process.argv[1];
const isEntrypoint = invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href;
if (isEntrypoint) {
  await main();
}
