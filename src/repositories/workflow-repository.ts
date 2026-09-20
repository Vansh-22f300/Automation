/**
 * Tenant-scoped workflow and workflow-version management.
 *
 * This is the business-logic layer for authoring workflows: it owns the rules
 * that a route handler or CLI must not re-implement — validate the definition and
 * trigger config before anything is written, assign monotonic version numbers,
 * and keep "exactly one active version" true through every transition. Route
 * handlers (when they exist) stay thin and call in here.
 *
 * Two invariants are load-bearing and are enforced with the database, not just
 * application code:
 *
 * 1. **Versions are immutable.** There is no method that updates a version's
 *    `definition` or `trigger_config`. A new version is always a fresh INSERT;
 *    version 1 is never touched when version 2 is created. The only mutable field
 *    is `is_active`, which is metadata about *which* version is current, not part
 *    of the versioned logic.
 * 2. **At most one active version per workflow.** Promotion deactivates the
 *    current active version and activates the new one inside a single
 *    transaction, so the partial unique index is never transiently violated.
 *
 * Everything is pinned to one tenant via `TenantScope`, so no operation can read
 * or mutate another tenant's workflows — a lookup that misses the tenant simply
 * raises `NotFoundError`, indistinguishable from a genuinely absent row.
 */

import { and, desc, eq, lt, or, sql } from "drizzle-orm";

import { BadRequestError } from "@/api/errors.js";
import { NotFoundError } from "@/api/errors.js";
import { PermanentError } from "@/domain/errors.js";
import { parseWorkflowDefinition } from "@/domain/workflow-definition.js";
import { parseTriggerConfig } from "@/domain/workflow-trigger.js";
import type { TriggerType } from "@/domain/workflow-trigger.js";
import { workflowVersions, workflows } from "@/db/schema.js";
import type { Workflow, WorkflowVersion } from "@/db/schema.js";
import {
  TenantScope,
  TenantScopedRepository,
} from "@/repositories/tenant-scope.js";

export interface WorkflowListItem {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activeVersion: {
    readonly id: string;
    readonly version: number;
    readonly triggerType: string;
  } | null;
}

export interface WorkflowListPage {
  readonly items: readonly WorkflowListItem[];
  readonly nextCursor: string | null;
}

export interface WorkflowListReader {
  listWorkflows(limit?: number, cursor?: string): Promise<WorkflowListPage>;
}

/** What a caller supplies to author a brand-new workflow and its first version. */
export interface CreateWorkflowInput {
  readonly name: string;
  /** Unknown until validated against the workflow-definition schema. */
  readonly definition: unknown;
  readonly triggerType: TriggerType;
  /** Unknown until validated against the trigger-config schema for `triggerType`. */
  readonly triggerConfig: unknown;
  /** Whether the first version is active immediately. Defaults to true. */
  readonly activate?: boolean;
}

/** What a caller supplies to add a new version to an existing workflow. */
export interface CreateVersionInput {
  readonly definition: unknown;
  readonly triggerType: TriggerType;
  readonly triggerConfig: unknown;
  /** Whether this new version becomes the active one. Defaults to false. */
  readonly activate?: boolean;
}

/** Validate the definition and trigger config, or throw a `PermanentError`. */
function validateDefinitionAndTrigger(input: {
  definition: unknown;
  triggerType: TriggerType;
  triggerConfig: unknown;
}): {
  definition: Record<string, unknown>;
  triggerConfig: Record<string, unknown>;
} {
  let definition: Record<string, unknown>;
  try {
    definition = parseWorkflowDefinition(input.definition) as Record<
      string,
      unknown
    >;
  } catch (cause) {
    throw new PermanentError(
      "invalid_definition",
      "Workflow definition is invalid",
      { cause },
    );
  }

  let triggerConfig: Record<string, unknown>;
  try {
    triggerConfig = parseTriggerConfig(
      input.triggerType,
      input.triggerConfig,
    ) as Record<string, unknown>;
  } catch (cause) {
    throw new PermanentError(
      "invalid_trigger_config",
      "Trigger configuration is invalid",
      {
        cause,
      },
    );
  }

  return { definition, triggerConfig };
}

/** The result of authoring a workflow: the workflow row and its first version. */
export interface CreatedWorkflow {
  readonly workflow: Workflow;
  readonly version: WorkflowVersion;
}

/**
 * Tenant-scoped repository for workflows and their versions.
 *
 * Construct one per authenticated context from a `TenantScope`; every method is
 * intrinsically pinned to that tenant. There is deliberately no unscoped variant.
 */
export class WorkflowRepository
  extends TenantScopedRepository
  implements WorkflowListReader
{
  constructor(scope: TenantScope) {
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

  /**
   * Author a new workflow and its version 1 in a single transaction.
   *
   * Validation happens before the transaction opens, so a bad definition never
   * leaves a half-written workflow behind. Version 1 is `is_active` by default —
   * a workflow with no runnable version is rarely what a caller wants — but that
   * can be turned off with `activate: false`.
   */
  async create(input: CreateWorkflowInput): Promise<CreatedWorkflow> {
    const { definition, triggerConfig } = validateDefinitionAndTrigger(input);
    const activate = input.activate ?? true;

    return this.db.transaction(async (tx) => {
      // The status label tracks whether the workflow has a runnable (active)
      // version: `active` when version 1 is activated now, otherwise `draft`.
      // Execution still routes on `workflowVersions.isActive`; status is the
      // user-facing projection of it, never a second source of truth.
      const [workflow] = await tx
        .insert(workflows)
        .values({ tenantId: this.tenantId, name: input.name, status: activate ? 'active' : 'draft' })
        .returning();

      // The insert always returns exactly one row.
      const createdWorkflow = workflow!;

      const [version] = await tx
        .insert(workflowVersions)
        .values({
          tenantId: this.tenantId,
          workflowId: createdWorkflow.id,
          version: 1,
          definition,
          triggerType: input.triggerType,
          triggerConfig,
          isActive: activate,
        })
        .returning();

      return { workflow: createdWorkflow, version: version! };
    });
  }

  /**
   * Add a new immutable version to an existing workflow.
   *
   * The existing versions are never touched except for the single `is_active`
   * flip that promotion needs. The whole thing runs in one transaction that opens
   * by taking a `FOR UPDATE` lock on the workflow row: that serialises concurrent
   * version creation for *this* workflow, so `max(version) + 1` cannot race two
   * inserts to the same number. The `unique(workflow_id, version)` constraint is
   * the database backstop if that reasoning is ever wrong.
   *
   * Throws `NotFoundError` if the workflow is not this tenant's — the same answer
   * as a genuinely absent workflow, so another tenant's ids are never revealed.
   */
  async createVersion(
    workflowId: string,
    input: CreateVersionInput,
  ): Promise<WorkflowVersion> {
    const { definition, triggerConfig } = validateDefinitionAndTrigger(input);
    const activate = input.activate ?? false;

    return this.db.transaction(async (tx) => {
      // Lock the workflow row and prove tenant ownership in one step. `FOR UPDATE`
      // blocks any concurrent version creation for this workflow until we commit.
      const locked = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          and(
            eq(workflows.id, workflowId),
            eq(workflows.tenantId, this.tenantId),
          ),
        )
        .for("update");

      if (locked.length === 0) {
        throw new NotFoundError("Workflow not found");
      }

      const [current] = await tx
        .select({ max: sql<number | null>`max(${workflowVersions.version})` })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.workflowId, workflowId),
            eq(workflowVersions.tenantId, this.tenantId),
          ),
        );
      const nextVersion = (current?.max ?? 0) + 1;

      if (activate) {
        // Deactivate before activating so the partial unique index is never
        // transiently violated within the transaction.
        await tx
          .update(workflowVersions)
          .set({ isActive: false })
          .where(
            and(
              eq(workflowVersions.workflowId, workflowId),
              eq(workflowVersions.tenantId, this.tenantId),
              eq(workflowVersions.isActive, true),
            ),
          );

        // The workflow now has a runnable version → its status label is `active`.
        // (activate=false leaves the parent status untouched.)
        await tx
          .update(workflows)
          .set({ status: "active" })
          .where(
            and(eq(workflows.id, workflowId), eq(workflows.tenantId, this.tenantId)),
          );
      }

      const [version] = await tx
        .insert(workflowVersions)
        .values({
          tenantId: this.tenantId,
          workflowId,
          version: nextVersion,
          definition,
          triggerType: input.triggerType,
          triggerConfig,
          isActive: activate,
        })
        .returning();

      return version!;
    });
  }

  /**
   * Make a specific version the active one, deactivating whichever version is
   * active now. Idempotent: activating the already-active version is a no-op that
   * still succeeds. Both the workflow and the version must be this tenant's, or
   * `NotFoundError` is thrown.
   */
  async activateVersion(workflowId: string, versionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const locked = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          and(
            eq(workflows.id, workflowId),
            eq(workflows.tenantId, this.tenantId),
          ),
        )
        .for("update");

      if (locked.length === 0) {
        throw new NotFoundError("Workflow not found");
      }

      const [target] = await tx
        .select({ id: workflowVersions.id })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.id, versionId),
            eq(workflowVersions.workflowId, workflowId),
            eq(workflowVersions.tenantId, this.tenantId),
          ),
        );

      if (!target) {
        throw new NotFoundError("Workflow version not found");
      }

      await tx
        .update(workflowVersions)
        .set({ isActive: false })
        .where(
          and(
            eq(workflowVersions.workflowId, workflowId),
            eq(workflowVersions.tenantId, this.tenantId),
            eq(workflowVersions.isActive, true),
          ),
        );

      await tx
        .update(workflowVersions)
        .set({ isActive: true })
        .where(
          and(
            eq(workflowVersions.id, versionId),
            eq(workflowVersions.tenantId, this.tenantId),
          ),
        );

      // A workflow with an active version is `active` — this also re-enables a
      // previously `disabled` workflow, the intended way to bring one back.
      await tx
        .update(workflows)
        .set({ status: "active" })
        .where(
          and(eq(workflows.id, workflowId), eq(workflows.tenantId, this.tenantId)),
        );
    });
  }

  /**
   * Disable a workflow: mark it `disabled` AND deactivate every currently active
   * version, in one transaction. Because webhook routing selects the target purely
   * by `is_active`, removing the active version is what actually stops new runs —
   * the status label alone would not. Version rows are otherwise untouched (only
   * `is_active` flips) and nothing is deleted, so the history stays intact and the
   * workflow can be brought back with `activateVersion`.
   *
   * Idempotent: disabling an already-disabled workflow deactivates nothing further
   * and still succeeds. Both the workflow must be this tenant's, or `NotFoundError`
   * is thrown — the same tenant-safe answer as `activateVersion`/`createVersion`.
   */
  async disable(workflowId: string): Promise<Workflow> {
    return this.db.transaction(async (tx) => {
      // Lock the workflow row and prove tenant ownership in one step, mirroring
      // the other mutating methods so disable serialises against version changes.
      const locked = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          and(eq(workflows.id, workflowId), eq(workflows.tenantId, this.tenantId)),
        )
        .for("update");

      if (locked.length === 0) {
        throw new NotFoundError("Workflow not found");
      }

      // Deactivate any active version(s) — after this there is no active version,
      // so a webhook for this workflow's source can match nothing and creates no run.
      await tx
        .update(workflowVersions)
        .set({ isActive: false })
        .where(
          and(
            eq(workflowVersions.workflowId, workflowId),
            eq(workflowVersions.tenantId, this.tenantId),
            eq(workflowVersions.isActive, true),
          ),
        );

      const [updated] = await tx
        .update(workflows)
        .set({ status: "disabled" })
        .where(
          and(eq(workflows.id, workflowId), eq(workflows.tenantId, this.tenantId)),
        )
        .returning();

      return updated!;
    });
  }

  /** Fetch one of this tenant's workflows, or throw `NotFoundError`. */
  async getWorkflow(workflowId: string): Promise<Workflow> {
    const [workflow] = await this.db
      .select()
      .from(workflows)
      .where(
        this.scope.where(workflows.tenantId, eq(workflows.id, workflowId)),
      );

    if (!workflow) {
      throw new NotFoundError("Workflow not found");
    }
    return workflow;
  }

  /** List every version of a workflow, newest version number first. */
  async listVersions(workflowId: string): Promise<WorkflowVersion[]> {
    return this.db
      .select()
      .from(workflowVersions)
      .where(
        this.scope.where(
          workflowVersions.tenantId,
          eq(workflowVersions.workflowId, workflowId),
        ),
      )
      .orderBy(sql`${workflowVersions.version} desc`);
  }

  /** The active version of a workflow, or `null` if none is active. */
  async getActiveVersion(workflowId: string): Promise<WorkflowVersion | null> {
    const [version] = await this.db
      .select()
      .from(workflowVersions)
      .where(
        this.scope.where(
          workflowVersions.tenantId,
          eq(workflowVersions.workflowId, workflowId),
          eq(workflowVersions.isActive, true),
        ),
      );

    return version ?? null;
  }

  async listWorkflows(limit = 20, cursor?: string): Promise<WorkflowListPage> {
    const pageLimit = Math.max(1, Math.min(limit, 100));
    const parsedCursor =
      cursor === undefined ? null : WorkflowRepository.decodeCursor(cursor);
    const cursorClause =
      parsedCursor === null
        ? undefined
        : or(
            sql`${workflows.createdAt} < ${new Date(parsedCursor.createdAt)}`,
            and(
              eq(workflows.createdAt, new Date(parsedCursor.createdAt)),
              lt(workflows.id, parsedCursor.id),
            ),
          );

    const rows = await this.db
      .select({
        workflow: workflows,
        activeVersionId: workflowVersions.id,
        activeVersionVersion: workflowVersions.version,
        activeVersionTriggerType: workflowVersions.triggerType,
      })
      .from(workflows)
      .leftJoin(
        workflowVersions,
        and(
          eq(workflowVersions.workflowId, workflows.id),
          eq(workflowVersions.tenantId, workflows.tenantId),
          eq(workflowVersions.isActive, true),
        ),
      )
      .where(
        cursorClause === undefined
          ? this.scope.where(workflows.tenantId)
          : this.scope.where(workflows.tenantId, cursorClause),
      )
      .orderBy(desc(workflows.createdAt), desc(workflows.id))
      .limit(pageLimit + 1);

    const items = rows.slice(0, pageLimit).map((row) => ({
      id: row.workflow.id,
      name: row.workflow.name,
      status: row.workflow.status,
      createdAt: row.workflow.createdAt.toISOString(),
      updatedAt: row.workflow.updatedAt.toISOString(),
      activeVersion:
        row.activeVersionId === null
          ? null
          : {
              id: row.activeVersionId,
              version: row.activeVersionVersion!,
              triggerType: row.activeVersionTriggerType!,
            },
    }));

    const lastRow = rows[pageLimit - 1];
    const nextCursor =
      rows.length > pageLimit && lastRow !== undefined
        ? WorkflowRepository.encodeCursor({
            createdAt: lastRow.workflow.createdAt.toISOString(),
            id: lastRow.workflow.id,
          })
        : null;

    return { items, nextCursor };
  }
}
