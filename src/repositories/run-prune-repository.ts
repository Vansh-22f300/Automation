/**
 * Tenant-scoped retention repository for `workflow_runs`.
 *
 * Implements the narrowest possible surface for `pnpm runs:prune`: a single
 * listing query (terminal + age-eligible rows, keyset-paginated) and a single
 * delete query (compare-and-set on tenant, id, terminal status, age cutoff).
 * The single DELETE cascades to `jobs`, `workflow_step_runs` and `llm_usage`
 * via the FK constraints already declared in `src/db/schema.ts` — no manual
 * child delete is performed here.
 *
 * Protected tables are never touched by this repository:
 *   - `tenants`, `users`, `api_keys`, `connections`, `workflows`,
 *     `workflow_versions`, `events` are not referenced by any statement.
 *   - `workflow_runs` parents (the workflow, version, and event rows) are
 *     unchanged even when their child run is pruned, because every statement
 *     targets `workflow_runs` only — and the cascade fires only on a row in
 *     `workflow_runs` being deleted, never on a column being NULLed out.
 *
 * Eligibility (encoded in `listPrunable` and `pruneRun` identically):
 *
 *   status IN ('succeeded', 'failed', 'cancelled')   -- TERMINAL_RUN_STATUSES
 *   AND finished_at IS NOT NULL
 *   AND finished_at < cutoff
 *
 * The `finished_at IS NOT NULL` arm is belt-and-braces: the engine always
 * sets `finished_at` when it transitions to a terminal status, but defence
 * in depth is cheap and the partial index `workflow_runs_tenant_id_finished_at_terminal_idx`
 * already excludes NULLs in its leading column.
 */

import { and, desc, eq, inArray, isNotNull, lt, or } from 'drizzle-orm';

import { workflowRuns } from '@/db/schema.js';
import { TERMINAL_RUN_STATUSES } from '@/domain/run-state.js';
import { TenantScope, TenantScopedRepository } from '@/repositories/tenant-scope.js';

/** Status of a single prunable run, projected from `workflow_runs`. */
export interface PrunableRun {
  readonly id: string;
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly finishedAt: Date;
}

/** One page of prunable runs plus a keyset cursor. */
export interface PrunableListPage {
  readonly items: readonly PrunableRun[];
  readonly nextCursor: string | null;
}

/** Options for {@link RunPruneRepository.listPrunable}. */
export interface ListPrunableOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

/** Outcome of a single prune attempt on one run id. */
export interface PruneRunOutcome {
  readonly outcome: 'pruned' | 'skipped' | 'not-found';
  readonly id: string;
  readonly status: 'succeeded' | 'failed' | 'cancelled' | null;
  readonly finishedAt: Date | null;
}

export class RunPruneRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }
  /**
   * Enumerate this tenant's prunable runs — terminal + age-eligible, ordered
   * newest-finished first so operators can read the listing in
   * human-friendly order.
   *
   * The query is a plain SELECT — no `FOR UPDATE`. A concurrent prune run on
   * the same tenant does not contend with this listing, and the engine's
   * short row locks on `workflow_runs` (during `beginStep`/`settleStep`) only
   * block the per-row DELETE in {@link pruneRun}, not this query.
   */
  async listPrunable(
    cutoff: Date,
    options: ListPrunableOptions = {},
  ): Promise<PrunableListPage> {
    const pageLimit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    const parsedCursor =
      options.cursor === undefined ? null : RunPruneRepository.decodeCursor(options.cursor);
    const cursorFinishedAt =
      parsedCursor === null ? null : new Date(parsedCursor.finishedAt);
    const cursorId = parsedCursor?.id;

    const cursorClause =
      cursorFinishedAt === null || cursorId === undefined
        ? undefined
        : or(
            lt(workflowRuns.finishedAt, cursorFinishedAt),
            and(
              eq(workflowRuns.finishedAt, cursorFinishedAt),
              lt(workflowRuns.id, cursorId),
            ),
          );

    const baseConditions = [
      inArray(workflowRuns.status, TERMINAL_RUN_STATUSES),
      isNotNull(workflowRuns.finishedAt),
      lt(workflowRuns.finishedAt, cutoff),
      cursorClause,
    ].filter(
      (condition): condition is NonNullable<typeof condition> =>
        condition !== undefined,
    );

    const rows = await this.db
      .select({
        id: workflowRuns.id,
        status: workflowRuns.status,
        finishedAt: workflowRuns.finishedAt,
      })
      .from(workflowRuns)
      .where(this.scope.where(workflowRuns.tenantId, ...baseConditions))
      .orderBy(desc(workflowRuns.finishedAt), desc(workflowRuns.id))
      .limit(pageLimit + 1);

    const items = rows.slice(0, pageLimit).map((row) => ({
      id: row.id,
      status: row.status as 'succeeded' | 'failed' | 'cancelled',
      finishedAt: row.finishedAt as Date,
    }));

    const lastRow = rows[pageLimit - 1];
    const nextCursor =
      rows.length > pageLimit && lastRow !== undefined && lastRow.finishedAt !== null
        ? RunPruneRepository.encodeCursor({
            finishedAt: lastRow.finishedAt.toISOString(),
            id: lastRow.id,
          })
        : null;

    return { items, nextCursor };
  }

  /**
   * Delete a single run if (and only if) it remains terminal and remains
   * past the cutoff at delete time. The compare-and-set WHERE clause makes
   * the operation safe across races: a row that has somehow transitioned
   * out of a terminal state (it cannot, by the absorbing-state invariant in
   * `src/domain/run-state.ts`, but defence in depth) matches zero rows and
   * the caller counts it as `skipped` rather than `pruned`.
   *
   * The cascade from `workflow_runs` to `jobs`, `workflow_step_runs`, and
   * `llm_usage` happens in the same statement. Protected tables
   * (`workflows`, `workflow_versions`, `events`, `connections`, `tenants`,
   * `users`, `api_keys`) are unchanged — the cascade is one-way and only
   * fires on the child side.
   */
  async pruneRun(id: string, cutoff: Date): Promise<PruneRunOutcome> {
    const rows = await this.db
      .delete(workflowRuns)
      .where(
        and(
          eq(workflowRuns.tenantId, this.tenantId),
          eq(workflowRuns.id, id),
          inArray(workflowRuns.status, TERMINAL_RUN_STATUSES),
          isNotNull(workflowRuns.finishedAt),
          lt(workflowRuns.finishedAt, cutoff),
        ),
      )
      .returning({
        id: workflowRuns.id,
        status: workflowRuns.status,
        finishedAt: workflowRuns.finishedAt,
      });

    const row = rows[0];
    if (row === undefined) {
      return { outcome: 'not-found', id, status: null, finishedAt: null };
    }
    return {
      outcome: 'pruned',
      id: row.id,
      status: row.status as 'succeeded' | 'failed' | 'cancelled',
      finishedAt: row.finishedAt as Date,
    };
  }

  private static encodeCursor(cursor: {
    readonly finishedAt: string;
    readonly id: string;
  }): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private static decodeCursor(cursor: string): {
    readonly finishedAt: string;
    readonly id: string;
  } {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as {
      finishedAt?: unknown;
      id?: unknown;
    };
    if (
      typeof parsed.finishedAt !== 'string' ||
      typeof parsed.id !== 'string'
    ) {
      throw new Error('invalid prune cursor');
    }
    if (Number.isNaN(new Date(parsed.finishedAt).getTime())) {
      throw new Error('invalid prune cursor');
    }
    return { finishedAt: parsed.finishedAt, id: parsed.id };
  }
}
