/**
 * The rotation logic for `pnpm connections rotate`, factored out so the
 * dispatcher in `src/cli/connections.ts` stays a thin shell and the iteration
 * behaviour can be exercised by unit tests against a fake repository.
 *
 * Contract (mirrors §8 of the architectural plan):
 *
 *   - `runRotate({...})` pages through the tenant's rotatable connections,
 *     decrypts each row with the same AAD a real rotation would apply, and
 *     either re-encrypts the row (real run) or just classifies the outcome
 *     (dry-run).
 *   - In `--dry-run` mode: NO database writes. Per-row outcome is
 *     `would-rotate` or `would-fail <reason>`. Reasons map deterministically
 *     from the underlying {@link CredentialDecryptionError} message.
 *   - In real-run mode: each row is its own short transaction via
 *     `repository.rotateCredentials`. Per-row outcome is `rotated`,
 *     `skipped` (already current or not in tenant), or `failed`.
 *   - Exit code semantics (0 / 1 / 2) match §8 of the plan.
 *
 * NEVER-LOG list (enforced by `runRotate`):
 *
 *   - Plaintext credential (never returned by `cipher.decrypt` callers
 *     here; we discard it immediately).
 *   - Key material (raw or base64).
 *   - Envelope `iv`, `ct`, `tag` fields.
 *   - Cause object of any thrown `Error`.
 *
 * Per-row stdout output carries only `connectionId`, `provider/name`,
 * `old_kid` (or `legacy-v1` for v1 envelopes), `new_kid` (always the
 * active kid), and a typed reason on failure. Failure events are logged
 * through the supplied logger with the same identifier-only shape.
 */

import { isAppError } from '@/domain/errors.js';
import type { Logger } from '@/observability/logger.js';
import type { ConnectionRepository, RotatableConnection } from '@/repositories/connection-repository.js';
import {
  CredentialCipher,
  CredentialDecryptionError,
} from '@/security/credential-cipher.js';

export interface RunRotateOptions {
  readonly repository: ConnectionRepository;
  readonly cipher: CredentialCipher;
  readonly tenantId: string;
  readonly activeKid: string;
  /** When non-null, rotate just this connection id. */
  readonly connectionId: string | null;
  readonly dryRun: boolean;
  readonly batchSize: number;
  /**
   * Output sink for per-row lines and the summary. Default is `process.stdout`,
   * but tests inject a buffer to assert on the exact lines emitted.
   */
  readonly stdout?: NodeJS.WritableStream;
  /** Logger for typed failure events; tests inject a stub. */
  readonly logger?: Logger;
}

export interface RunRotateSummary {
  readonly rotated: number;
  readonly skipped: number;
  readonly failed: number;
  readonly wouldRotate: number;
  readonly wouldFail: number;
  readonly dryRun: boolean;
}

/**
 * Map a decrypt failure to a stable, operator-readable typed reason. The
 * underlying {@link CredentialDecryptionError} collapses every failure mode
 * into one error class with a descriptive message; this peels the message
 * back into the documented categories without leaking it.
 */
export function reasonForDecryptFailure(error: unknown): string {
  if (error instanceof CredentialDecryptionError) {
    if (error.message.includes('legacy_v1_key_missing')) return 'legacy_v1_key_missing';
    if (error.message.includes('unknown_kid')) return 'unknown_kid';
    if (error.message.includes('malformed')) return 'malformed_envelope';
    if (error.message.includes('unsupported credential envelope')) return 'malformed_envelope';
    if (error.message.includes('missing a kid')) return 'malformed_envelope';
    return 'decrypt_failed';
  }
  if (isAppError(error)) return 'db_error';
  if (error instanceof Error) return 'db_error';
  return 'db_error';
}

/** Old kid label for the per-row output line. v1 envelopes have no kid. */
export function oldKidOf(row: RotatableConnection): string {
  const env = row.encryptedCredentials;
  if (env.v === 2 && typeof env.kid === 'string') return env.kid;
  return 'legacy-v1';
}

function write(out: NodeJS.WritableStream, line: string): void {
  out.write(line + '\n');
}

function classifyDryRun(
  cipher: CredentialCipher,
  tenantId: string,
  row: RotatableConnection,
): { readonly outcome: 'would-rotate' | 'would-fail'; readonly reason: string } {
  const aad = Buffer.from(`${tenantId}:${row.id}`, 'utf8');
  try {
    cipher.decrypt(row.encryptedCredentials, {
      tenantId,
      connectionId: row.id,
      aad,
    });
    return { outcome: 'would-rotate', reason: '' };
  } catch (error) {
    return { outcome: 'would-fail', reason: reasonForDecryptFailure(error) };
  }
}

export async function runRotate(options: RunRotateOptions): Promise<RunRotateSummary> {
  const { repository, cipher, tenantId, activeKid, connectionId, dryRun, batchSize } = options;
  const out = options.stdout ?? process.stdout;
  const logger = options.logger;
  let rotated = 0;
  let skipped = 0;
  let failed = 0;
  let wouldRotate = 0;
  let wouldFail = 0;

  if (connectionId !== null) {
    if (dryRun) {
      // Targeted dry-run: scan the rotatable pages for the named id. A row
      // already on the active kid is not in the rotatable predicate and is
      // therefore a quiet no-op (the CLI does not emit "would-fail" for an
      // already-current row in the targeted case — only the iteration loop
      // produces "would-fail" lines).
      let cursor: string | null = null;
      for (let safety = 0; safety < 1_000; safety++) {
        const page: { items: readonly RotatableConnection[]; nextCursor: string | null } =
          await repository.listRotatable(activeKid, {
            limit: batchSize,
            ...(cursor !== null ? { cursor } : {}),
          });
        const hit = page.items.find((r) => r.id === connectionId);
        if (hit !== undefined) {
          const { outcome, reason } = classifyDryRun(cipher, tenantId, hit);
          if (outcome === 'would-rotate') {
            wouldRotate++;
            write(
              out,
              `  [dry-run] would-rotate ${hit.id} ${hit.provider}/${hit.name} ${oldKidOf(hit)} -> ${activeKid}`,
            );
          } else {
            wouldFail++;
            write(
              out,
              `  [dry-run] would-fail    ${hit.id} ${hit.provider}/${hit.name} ${reason}`,
            );
          }
          return printSummary(out, { rotated, skipped, failed, wouldRotate, wouldFail, dryRun: true });
        }
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      return printSummary(out, { rotated, skipped, failed, wouldRotate, wouldFail, dryRun: true });
    }
    const result = await repository.rotateCredentials(connectionId, activeKid);
    if (result === null) {
      skipped++;
      write(out, `  skipped ${connectionId} (already current or not in tenant)`);
    } else {
      rotated++;
      write(out, `  rotated ${result.id} ${result.provider}/${result.name} -> ${activeKid}`);
    }
    return printSummary(out, { rotated, skipped, failed, wouldRotate, wouldFail, dryRun: false });
  }

  let cursor: string | null = null;
  for (let safety = 0; safety < 1_000; safety++) {
    const page: { items: readonly RotatableConnection[]; nextCursor: string | null } =
      await repository.listRotatable(activeKid, {
        limit: batchSize,
        ...(cursor !== null ? { cursor } : {}),
      });
    for (const row of page.items) {
      if (dryRun) {
        const { outcome, reason } = classifyDryRun(cipher, tenantId, row);
        if (outcome === 'would-rotate') {
          wouldRotate++;
          write(
            out,
            `  [dry-run] would-rotate ${row.id} ${row.provider}/${row.name} ${oldKidOf(row)} -> ${activeKid}`,
          );
        } else {
          wouldFail++;
          write(
            out,
            `  [dry-run] would-fail    ${row.id} ${row.provider}/${row.name} ${reason}`,
          );
        }
        continue;
      }
      try {
        const updated = await repository.rotateCredentials(row.id, activeKid);
        if (updated === null) {
          skipped++;
          write(out, `  skipped ${row.id} ${row.provider}/${row.name} (already current)`);
        } else {
          rotated++;
          write(
            out,
            `  rotated ${updated.id} ${updated.provider}/${updated.name} ${oldKidOf(row)} -> ${activeKid}`,
          );
        }
      } catch (error) {
        failed++;
        const reason = reasonForDecryptFailure(error);
        if (logger !== undefined) {
          logger.error(
            {
              event: 'connection_rotate_failed',
              tenant_id: tenantId,
              connection_id: row.id,
              reason,
            },
            'connection_rotate_failed',
          );
        }
        write(out, `  failed  ${row.id} ${row.provider}/${row.name} ${reason}`);
      }
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return printSummary(out, { rotated, skipped, failed, wouldRotate, wouldFail, dryRun });
}

function printSummary(out: NodeJS.WritableStream, s: RunRotateSummary): RunRotateSummary {
  if (s.dryRun) {
    write(
      out,
      [
        '',
        '[dry-run] summary',
        `would-rotate: ${s.wouldRotate}`,
        `would-fail:    ${s.wouldFail}`,
        '',
      ].join('\n'),
    );
  } else {
    write(
      out,
      [
        '',
        `rotated: ${s.rotated}`,
        `skipped: ${s.skipped}  (already current)`,
        `failed:  ${s.failed}`,
        '',
      ].join('\n'),
    );
  }
  return s;
}

/** Compute the CLI exit code from a run summary, per §8 of the plan. */
export function exitCodeFor(s: RunRotateSummary): number {
  if (s.dryRun) {
    if (s.wouldRotate > 0 && s.wouldFail > 0) return 1;
    if (s.wouldRotate === 0 && s.wouldFail > 0) return 2;
    return 0;
  }
  if (s.rotated > 0 && s.failed > 0) return 1;
  if (s.rotated === 0 && s.failed > 0) return 2;
  return 0;
}
