/**
 * Tenant-scoped run inspection: assemble one coherent, safe view of a single run.
 *
 * This is the single source of truth for "show me run R", shared verbatim by the
 * `runs:inspect` CLI and the `GET /v1/runs/:runId` endpoint. Neither of those
 * duplicates a query or a redaction rule — they both call `getRun` and render the
 * `RunInspection` the pure assembler (`@/domain/run-inspection`) produces.
 *
 * Every read goes through `scope.where(...)`, so a caller can only ever see runs
 * of its own tenant. A run id that does not exist *for this tenant* — whether it
 * is genuinely absent or belongs to someone else — returns `null`, which the API
 * turns into an identical 404. The lookup is a small, fixed number of point
 * queries (one per section), independent of how many rows a run accumulated.
 */

import { and, desc, eq, lt, or } from "drizzle-orm";

import { BadRequestError } from "@/api/errors.js";
import {
  events,
  jobs,
  llmUsage,
  workflowRuns,
  workflowStepRuns,
  workflowVersions,
  workflows,
} from "@/db/schema.js";
import { assembleRunInspection } from "@/domain/run-inspection.js";
import type { RunInspection } from "@/domain/run-inspection.js";
import { toSafeError } from "@/domain/redaction.js";
import type { SafeErrorDto } from "@/domain/redaction.js";
import {
  TenantScope,
  TenantScopedRepository,
} from "@/repositories/tenant-scope.js";

/** Per-call options. `detail` attaches secret-scrubbed raw values (CLI `--detail`). */
export interface RunInspectionOptions {
  readonly detail?: boolean;
}

/** The capability the CLI and the API route depend on. */
export interface RunInspectionReader {
  getRun(
    runId: string,
    options?: RunInspectionOptions,
  ): Promise<RunInspection | null>;
}

export interface RunListItem {
  readonly id: string;
  readonly workflowId: string;
  readonly workflowName: string;
  readonly workflowVersionId: string;
  readonly status: string;
  readonly currentStepKey: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: SafeErrorDto | null;
}

export interface RunListPage {
  readonly items: readonly RunListItem[];
  readonly nextCursor: string | null;
}

export interface RunListReader {
  listRuns(options?: {
    readonly limit?: number;
    readonly cursor?: string;
    readonly status?: string;
    readonly workflowId?: string;
  }): Promise<RunListPage>;
}

export class RunInspectionRepository
  extends TenantScopedRepository
  implements RunInspectionReader, RunListReader
{
  /**
   * `now` is injected so lease-liveness (a job's `leased` flag) is deterministic
   * in tests. Defaults to the wall clock in production.
   */
  constructor(
    scope: TenantScope,
    private readonly now: () => Date = () => new Date(),
  ) {
    super(scope);
  }

  private static encodeCursor(cursor: {
    readonly createdAt: string;
    readonly id: string;
  }): string {
    return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  }

  private static decodeCursor(cursor: string): {
    createdAt: string;
    id: string;
  } {
    try {
      const parsed = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      ) as {
        createdAt?: unknown;
        id?: unknown;
      };
      if (
        typeof parsed.createdAt !== "string" ||
        typeof parsed.id !== "string"
      ) {
        throw new Error("invalid cursor");
      }
      if (Number.isNaN(new Date(parsed.createdAt).getTime())) {
        throw new Error("invalid cursor");
      }
      return { createdAt: parsed.createdAt, id: parsed.id };
    } catch {
      throw new BadRequestError("Cursor is invalid");
    }
  }

  async getRun(
    runId: string,
    options: RunInspectionOptions = {},
  ): Promise<RunInspection | null> {
    const [run] = await this.db
      .select()
      .from(workflowRuns)
      .where(
        this.scope.where(workflowRuns.tenantId, eq(workflowRuns.id, runId)),
      );
    if (run === undefined) return null;

    const [workflowRows, versionRows, eventRows, steps, jobRows, usage] =
      await Promise.all([
        this.db
          .select()
          .from(workflows)
          .where(
            this.scope.where(
              workflows.tenantId,
              eq(workflows.id, run.workflowId),
            ),
          ),
        this.db
          .select()
          .from(workflowVersions)
          .where(
            this.scope.where(
              workflowVersions.tenantId,
              eq(workflowVersions.id, run.workflowVersionId),
            ),
          ),
        this.db
          .select()
          .from(events)
          .where(this.scope.where(events.tenantId, eq(events.id, run.eventId))),
        this.db
          .select()
          .from(workflowStepRuns)
          .where(
            this.scope.where(
              workflowStepRuns.tenantId,
              eq(workflowStepRuns.runId, runId),
            ),
          )
          .orderBy(workflowStepRuns.startedAt),
        this.db
          .select()
          .from(jobs)
          .where(this.scope.where(jobs.tenantId, eq(jobs.runId, runId)))
          .orderBy(jobs.createdAt),
        this.db
          .select()
          .from(llmUsage)
          .where(
            this.scope.where(llmUsage.tenantId, eq(llmUsage.runId, runId)),
          ),
      ]);

    const workflow = workflowRows[0];
    const version = versionRows[0];
    const event = eventRows[0];
    // The composite FKs guarantee these exist for a run in this tenant; treat any
    // absence as "not found" rather than assembling a half-built view.
    if (workflow === undefined || version === undefined || event === undefined)
      return null;

    return assembleRunInspection(
      { run, workflow, version, event, steps, jobs: jobRows, llmUsage: usage },
      { detail: options.detail ?? false, now: this.now().getTime() },
    );
  }

  async listRuns(
    options: {
      readonly limit?: number;
      readonly cursor?: string;
      readonly status?: string;
      readonly workflowId?: string;
    } = {},
  ): Promise<RunListPage> {
    const pageLimit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const parsedCursor =
      options.cursor === undefined
        ? null
        : RunInspectionRepository.decodeCursor(options.cursor);
    const cursorDate =
      parsedCursor === null ? null : new Date(parsedCursor.createdAt);
    const cursorId = parsedCursor?.id;
    const cursorClause =
      cursorDate === null || cursorId === undefined
        ? undefined
        : or(
            lt(workflowRuns.createdAt, cursorDate),
            and(
              eq(workflowRuns.createdAt, cursorDate),
              lt(workflowRuns.id, cursorId),
            ),
          );

    const conditions = [
      options.status !== undefined
        ? eq(workflowRuns.status, options.status as never)
        : undefined,
      options.workflowId !== undefined
        ? eq(workflowRuns.workflowId, options.workflowId)
        : undefined,
      cursorClause,
    ].filter(
      (condition): condition is NonNullable<typeof condition> =>
        condition !== undefined,
    );

    const rows = await this.db
      .select({
        run: workflowRuns,
        workflowName: workflows.name,
      })
      .from(workflowRuns)
      .innerJoin(
        workflows,
        and(
          eq(workflows.id, workflowRuns.workflowId),
          eq(workflows.tenantId, workflowRuns.tenantId),
        ),
      )
      .where(this.scope.where(workflowRuns.tenantId, ...conditions))
      .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
      .limit(pageLimit + 1);

    const items = rows.slice(0, pageLimit).map((row) => ({
      id: row.run.id,
      workflowId: row.run.workflowId,
      workflowName: row.workflowName,
      workflowVersionId: row.run.workflowVersionId,
      status: row.run.status,
      currentStepKey: row.run.currentStepKey,
      createdAt: row.run.createdAt.toISOString(),
      startedAt: row.run.startedAt?.toISOString() ?? null,
      finishedAt: row.run.finishedAt?.toISOString() ?? null,
      error: toSafeError(row.run.error),
    }));

    const lastRow = rows[pageLimit - 1];
    const nextCursor =
      rows.length > pageLimit && lastRow !== undefined
        ? RunInspectionRepository.encodeCursor({
            createdAt: lastRow.run.createdAt.toISOString(),
            id: lastRow.run.id,
          })
        : null;

    return { items, nextCursor };
  }
}
