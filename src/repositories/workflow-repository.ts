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

import { and, eq, sql } from 'drizzle-orm';

import { NotFoundError } from '@/api/errors.js';
import { PermanentError } from '@/domain/errors.js';
import { parseWorkflowDefinition } from '@/domain/workflow-definition.js';
import { parseTriggerConfig } from '@/domain/workflow-trigger.js';
import type { TriggerType } from '@/domain/workflow-trigger.js';
import { workflowVersions, workflows } from '@/db/schema.js';
import type { Workflow, WorkflowVersion } from '@/db/schema.js';
import { TenantScope, TenantScopedRepository } from '@/repositories/tenant-scope.js';

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
}): { definition: Record<string, unknown>; triggerConfig: Record<string, unknown> } {
  let definition: Record<string, unknown>;
  try {
    definition = parseWorkflowDefinition(input.definition) as Record<string, unknown>;
  } catch (cause) {
    throw new PermanentError('invalid_definition', 'Workflow definition is invalid', { cause });
  }

  let triggerConfig: Record<string, unknown>;
  try {
    triggerConfig = parseTriggerConfig(input.triggerType, input.triggerConfig) as Record<
      string,
      unknown
    >;
  } catch (cause) {
    throw new PermanentError('invalid_trigger_config', 'Trigger configuration is invalid', {
      cause,
    });
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
export class WorkflowRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
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
      const [workflow] = await tx
        .insert(workflows)
        .values({ tenantId: this.tenantId, name: input.name })
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
  async createVersion(workflowId: string, input: CreateVersionInput): Promise<WorkflowVersion> {
    const { definition, triggerConfig } = validateDefinitionAndTrigger(input);
    const activate = input.activate ?? false;

    return this.db.transaction(async (tx) => {
      // Lock the workflow row and prove tenant ownership in one step. `FOR UPDATE`
      // blocks any concurrent version creation for this workflow until we commit.
      const locked = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.tenantId, this.tenantId)))
        .for('update');

      if (locked.length === 0) {
        throw new NotFoundError('Workflow not found');
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
        .where(and(eq(workflows.id, workflowId), eq(workflows.tenantId, this.tenantId)))
        .for('update');

      if (locked.length === 0) {
        throw new NotFoundError('Workflow not found');
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
        throw new NotFoundError('Workflow version not found');
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
    });
  }

  /** Fetch one of this tenant's workflows, or throw `NotFoundError`. */
  async getWorkflow(workflowId: string): Promise<Workflow> {
    const [workflow] = await this.db
      .select()
      .from(workflows)
      .where(this.scope.where(workflows.tenantId, eq(workflows.id, workflowId)));

    if (!workflow) {
      throw new NotFoundError('Workflow not found');
    }
    return workflow;
  }

  /** List every version of a workflow, newest version number first. */
  async listVersions(workflowId: string): Promise<WorkflowVersion[]> {
    return this.db
      .select()
      .from(workflowVersions)
      .where(this.scope.where(workflowVersions.tenantId, eq(workflowVersions.workflowId, workflowId)))
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
}
