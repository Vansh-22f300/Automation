/**
 * `pnpm runs:prune` — operator CLI for terminal-run retention.
 *
 * Walks the tenant's terminal workflow runs whose `finished_at` is older than
 * a caller-supplied cutoff, and (in real-run mode) deletes each in its own
 * short autocommit statement. The existing FK cascade from `workflow_runs`
 * removes the run's `jobs`, `workflow_step_runs`, and `llm_usage` rows
 * atomically; no manual child delete is performed. Protected tables
 * (`tenants`, `users`, `api_keys`, `connections`, `workflows`,
 * `workflow_versions`, `events`) are never touched.
 *
 * The CLI is intentionally narrow:
 *   - one positional argument: the tenant id (mirrors `runs:inspect`).
 *   - one required flag: `--older-than <Nd|Nh>`.
 *   - two optional flags: `--dry-run`, `--batch-size <N>`.
 *
 * Strict argument validation:
 *   - `--older-than` missing → refused.
 *   - `--older-than 0d`, negative, malformed, or > 5 years → refused.
 *   - `--batch-size` outside [1, 1000] → refused.
 *
 * Dry-run contract:
 *   - enumerates eligible rows via a plain SELECT (no `FOR UPDATE`).
 *   - performs ZERO writes.
 *   - reports per-row `would-prune` plus a summary.
 *
 * Real-run contract:
 *   - each row is one DELETE in one autocommit transaction.
 *   - the DELETE re-checks status + finished_at under the row lock
 *     (compare-and-set); a row whose status changed between list and
 *     delete is counted as `skipped`, not `failed`.
 *   - per-row errors (DB transient, FK violation surfaced for any reason)
 *     are logged and counted as `failed`; the loop continues.
 *
 * Exit codes:
 *   - real: 0 clean / pruned>0 with no failures; 1 partial (mix of pruned and
 *     failed); 2 total failure or boot-time misconfiguration.
 *   - dry-run: 0 (would-prune may be 0 — nothing to do — or > 0); 2 boot-time
 *     misconfiguration.
 */

import { pathToFileURL } from 'node:url';

import type { Logger } from '@/observability/logger.js';
import { loadEnv } from '@/config/env.js';
import { createDatabase } from '@/db/client.js';
import { createLogger } from '@/observability/logger.js';
import type {
  PrunableListPage,
  PruneRunOutcome,
} from '@/repositories/run-prune-repository.js';
import { RunPruneRepository } from '@/repositories/run-prune-repository.js';
import { TenantScope } from '@/repositories/tenant-scope.js';

/**
 * The `--older-than` value, parsed: a positive duration in milliseconds,
 * expressed as a number of `d` (days) or `h` (hours) with `Nd`/`Nh` syntax.
 * The maximum is bounded at 5 years so an operator cannot accidentally prune
 * "all terminal runs" by entering an enormous duration.
 */
export interface OlderThan {
  readonly milliseconds: number;
  readonly display: string;
}

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MAX_OLDER_THAN_MS = 5 * 365 * MS_PER_DAY + (MS_PER_DAY / 4); // 5y + leap-day slack
export const MAX_BATCH_SIZE = 1000;
export const DEFAULT_BATCH_SIZE = 100;

/**
 * Parse the value of `--older-than`. Accepts `Nd` (days) and `Nh` (hours);
 * rejects 0, negatives, malformed input, and anything greater than 5 years.
 */
export function parseOlderThan(raw: string): OlderThan {
  const match = /^(\d+)d$/.exec(raw) ?? /^(\d+)h$/.exec(raw);
  if (match === null) {
    throw new CliArgumentError(
      `--older-than must be of the form "<N>d" (days) or "<N>h" (hours); got "${raw}"`,
    );
  }
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliArgumentError(
      `--older-than must be a positive integer; got "${raw}"`,
    );
  }
  const milliseconds = raw.endsWith('d') ? n * MS_PER_DAY : n * MS_PER_HOUR;
  if (milliseconds > MAX_OLDER_THAN_MS) {
    throw new CliArgumentError(
      `--older-than exceeds the 5-year maximum; got "${raw}"`,
    );
  }
  return { milliseconds, display: raw };
}

/** Parse `--batch-size <N>`. Default {@link DEFAULT_BATCH_SIZE}; clamp [1, MAX_BATCH_SIZE]. */
export function parseBatchSize(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BATCH_SIZE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH_SIZE) {
    throw new CliArgumentError(
      `--batch-size must be an integer in [1, ${MAX_BATCH_SIZE}]; got "${raw}"`,
    );
  }
  return n;
}

/** Parse the entire argv vector for `runs:prune`. */
export interface ParsedArgs {
  readonly tenantId: string;
  readonly olderThan: OlderThan;
  readonly dryRun: boolean;
  readonly batchSize: number;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  // Walk argv once, tracking positional args explicitly so a flag's value
  // (e.g. `90d` after `--older-than`) is never mistaken for a positional.
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
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

  const tenantId = positional[0];
  if (tenantId === undefined || tenantId.trim() === '') {
    throw new CliArgumentError('usage: pnpm runs:prune <tenantId> --older-than <Nd|Nh> [--dry-run] [--batch-size <N>]');
  }

  const olderThanRaw = flags.get('--older-than');
  if (olderThanRaw === undefined || olderThanRaw === true) {
    throw new CliArgumentError(
      '--older-than is required (e.g. --older-than 90d or --older-than 24h)',
    );
  }

  const olderThan = parseOlderThan(olderThanRaw);
  const dryRun = flags.has('--dry-run');
  const batchSize = parseBatchSize(
    flags.get('--batch-size') === true ? undefined : (flags.get('--batch-size') as string | undefined),
  );

  return { tenantId, olderThan, dryRun, batchSize };
}

/** A user-facing CLI argument problem (not a runtime exception). */
export class CliArgumentError extends Error {
  readonly code = 'cli_argument_invalid';
  constructor(message: string) {
    super(message);
    this.name = 'CliArgumentError';
  }
}

/** The summary returned by {@link runPrune}. */
export interface RunPruneSummary {
  readonly pruned: number;
  readonly skipped: number;
  readonly failed: number;
  readonly wouldPrune: number;
  readonly wouldFail: number;
  readonly dryRun: boolean;
}

/** Options for {@link runPrune}. */
export interface RunPruneOptions {
  readonly repository: RunPruneRepository;
  readonly tenantId: string;
  readonly cutoff: Date;
  readonly batchSize: number;
  readonly dryRun: boolean;
  readonly stdout?: NodeJS.WritableStream;
  readonly logger?: Logger;
}

/** Map an unexpected throwable to a stable, operator-readable reason. */
export function reasonForPruneFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'Error' ? 'db_error' : error.name;
  }
  return 'db_error';
}

function write(out: NodeJS.WritableStream, line: string): void {
  out.write(line + '\n');
}

function printSummary(out: NodeJS.WritableStream, s: RunPruneSummary): RunPruneSummary {
  if (s.dryRun) {
    write(
      out,
      [
        '',
        '[dry-run] summary',
        `would-prune: ${s.wouldPrune}`,
        '',
      ].join('\n'),
    );
  } else {
    write(
      out,
      [
        '',
        `pruned: ${s.pruned}`,
        `skipped: ${s.skipped}  (status changed between list and delete)`,
        `failed:  ${s.failed}`,
        '',
      ].join('\n'),
    );
  }
  return s;
}

/**
 * Run the prune. In dry-run mode: enumerate eligible rows via the repository
 * and emit a `would-prune` line per row, performing no writes. In real-run
 * mode: enumerate, then call {@link RunPruneRepository.pruneRun} per row in
 * its own short autocommit transaction.
 */
export async function runPrune(options: RunPruneOptions): Promise<RunPruneSummary> {
  const { repository, tenantId, cutoff, batchSize, dryRun } = options;
  const out = options.stdout ?? process.stdout;
  const logger = options.logger;
  let pruned = 0;
  let skipped = 0;
  let failed = 0;
  let wouldPrune = 0;

  // Defensive: log the boot-time parameters at INFO so operators have a
  // single record of "what cutoff did this CLI use". Identifiers and counts
  // only; never run context, payloads, or step outputs.
  if (logger !== undefined) {
    logger.info(
      {
        event: 'run_prune_started',
        tenant_id: tenantId,
        cutoff: cutoff.toISOString(),
        dry_run: dryRun,
        batch_size: batchSize,
      },
      'run_prune_started',
    );
  }

  const startedAt = Date.now();
  let cursor: string | null = null;
  for (let safety = 0; safety < 1_000; safety++) {
    const page: PrunableListPage = await repository.listPrunable(cutoff, {
      limit: batchSize,
      ...(cursor !== null ? { cursor } : {}),
    });

    if (dryRun) {
      for (const row of page.items) {
        wouldPrune++;
        write(
          out,
          `  [dry-run] would-prune ${row.id} (${row.status}, finished=${row.finishedAt.toISOString()})`,
        );
      }
    } else {
      for (const row of page.items) {
        let outcome: PruneRunOutcome;
        try {
          outcome = await repository.pruneRun(row.id, cutoff);
        } catch (error) {
          failed++;
          const reason = reasonForPruneFailure(error);
          if (logger !== undefined) {
            logger.error(
              {
                event: 'run_prune_failed',
                tenant_id: tenantId,
                run_id: row.id,
                reason,
              },
              'run_prune_failed',
            );
          }
          write(out, `  failed  ${row.id} (${row.status}) ${reason}`);
          continue;
        }
        if (outcome.outcome === 'pruned') {
          pruned++;
          write(
            out,
            `  pruned ${row.id} (${outcome.status}, finished=${outcome.finishedAt?.toISOString() ?? '-'})`,
          );
        } else {
          skipped++;
          if (logger !== undefined) {
            logger.info(
              {
                event: 'run_prune_skipped',
                tenant_id: tenantId,
                run_id: row.id,
                reason: 'status_changed',
              },
              'run_prune_skipped',
            );
          }
          write(out, `  skipped ${row.id} (status changed at delete time)`);
        }
      }
    }

    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }

  const summary: RunPruneSummary = dryRun
    ? { pruned: 0, skipped: 0, failed: 0, wouldPrune, wouldFail: 0, dryRun: true }
    : { pruned, skipped, failed, wouldPrune: 0, wouldFail: 0, dryRun: false };
  printSummary(out, summary);

  if (logger !== undefined) {
    logger.info(
      {
        event: 'run_prune_completed',
        tenant_id: tenantId,
        pruned: summary.pruned,
        skipped: summary.skipped,
        failed: summary.failed,
        would_prune: summary.wouldPrune,
        dry_run: summary.dryRun,
        duration_ms: Date.now() - startedAt,
      },
      'run_prune_completed',
    );
  }

  return summary;
}

/** Compute the CLI exit code from a run summary, per §8 of the design. */
export function exitCodeFor(s: RunPruneSummary): number {
  if (s.dryRun) {
    if (s.wouldPrune === 0) return 0;
    return 0;
  }
  if (s.pruned > 0 && s.failed > 0) return 1;
  if (s.pruned === 0 && s.failed > 0) return 2;
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point (process wiring).
// ---------------------------------------------------------------------------
//
// Kept tiny so the logic above stays unit-testable. Mirror the structure of
// `src/cli/connections.ts` and `src/cli/runs-inspect.ts`: load env, build a
// logger + database handle, build the tenant-scoped repository, call the
// extracted `runPrune`, propagate exit code, close the pool in `finally`.

function usage(): never {
  process.stderr.write(
    [
      'usage:',
      '  pnpm runs:prune <tenantId> --older-than <Nd|Nh> [--dry-run] [--batch-size <N>]',
      '',
      'flags:',
      '  --older-than <Nd|Nh>   (required) age cutoff; e.g. 90d or 24h. Min 1d/1h, max 5y.',
      '  --dry-run              enumerate eligible runs and report; make no writes.',
      '  --batch-size <N>       rows per page (default 100, max 1000).',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    if (error instanceof CliArgumentError) {
      process.stderr.write(`${error.message}\n\n`);
      usage();
    }
    throw error;
  }

  const env = loadEnv();
  const logger = createLogger(env, { service: 'runs-prune' });
  const database = createDatabase(env, logger, { service: 'runs-prune' });

  try {
    await database.verifyConnection();

    const repository = new RunPruneRepository(new TenantScope(database.db, parsed.tenantId));
    const cutoff = new Date(Date.now() - parsed.olderThan.milliseconds);

    const summary = await runPrune({
      repository,
      tenantId: parsed.tenantId,
      cutoff,
      batchSize: parsed.batchSize,
      dryRun: parsed.dryRun,
      logger,
    });

    process.exitCode = exitCodeFor(summary);
  } catch (error) {
    if (error instanceof CliArgumentError) {
      process.stderr.write(`${error.message}\n\n`);
      usage();
    }
    logger.fatal({ err: error }, 'runs:prune failed');
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}

// Only invoke the entry point when this file is the process entry. Vitest
// imports the symbols above directly and never wants the CLI side effects
// (DB connection, exit) to fire as part of the import.
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
