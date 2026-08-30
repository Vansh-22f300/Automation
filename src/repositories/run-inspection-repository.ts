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

import { eq } from 'drizzle-orm';

import {
  events,
  jobs,
  llmUsage,
  workflowRuns,
  workflowStepRuns,
  workflowVersions,
  workflows,
} from '@/db/schema.js';
import { assembleRunInspection } from '@/domain/run-inspection.js';
import type { RunInspection } from '@/domain/run-inspection.js';
import { TenantScope, TenantScopedRepository } from '@/repositories/tenant-scope.js';

/** Per-call options. `detail` attaches secret-scrubbed raw values (CLI `--detail`). */
export interface RunInspectionOptions {
  readonly detail?: boolean;
}

/** The capability the CLI and the API route depend on. */
export interface RunInspectionReader {
  getRun(runId: string, options?: RunInspectionOptions): Promise<RunInspection | null>;
}

export class RunInspectionRepository extends TenantScopedRepository implements RunInspectionReader {
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

  async getRun(runId: string, options: RunInspectionOptions = {}): Promise<RunInspection | null> {
    const [run] = await this.db
      .select()
      .from(workflowRuns)
      .where(this.scope.where(workflowRuns.tenantId, eq(workflowRuns.id, runId)));
    if (run === undefined) return null;

    const [workflowRows, versionRows, eventRows, steps, jobRows, usage] = await Promise.all([
      this.db
        .select()
        .from(workflows)
        .where(this.scope.where(workflows.tenantId, eq(workflows.id, run.workflowId))),
      this.db
        .select()
        .from(workflowVersions)
        .where(this.scope.where(workflowVersions.tenantId, eq(workflowVersions.id, run.workflowVersionId))),
      this.db
        .select()
        .from(events)
        .where(this.scope.where(events.tenantId, eq(events.id, run.eventId))),
      this.db
        .select()
        .from(workflowStepRuns)
        .where(this.scope.where(workflowStepRuns.tenantId, eq(workflowStepRuns.runId, runId)))
        .orderBy(workflowStepRuns.startedAt),
      this.db
        .select()
        .from(jobs)
        .where(this.scope.where(jobs.tenantId, eq(jobs.runId, runId)))
        .orderBy(jobs.createdAt),
      this.db
        .select()
        .from(llmUsage)
        .where(this.scope.where(llmUsage.tenantId, eq(llmUsage.runId, runId))),
    ]);

    const workflow = workflowRows[0];
    const version = versionRows[0];
    const event = eventRows[0];
    // The composite FKs guarantee these exist for a run in this tenant; treat any
    // absence as "not found" rather than assembling a half-built view.
    if (workflow === undefined || version === undefined || event === undefined) return null;

    return assembleRunInspection(
      { run, workflow, version, event, steps, jobs: jobRows, llmUsage: usage },
      { detail: options.detail ?? false, now: this.now().getTime() },
    );
  }
}
