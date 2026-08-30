/**
 * Tenant-scoped webhook ingestion: capture an event and, if a workflow is
 * configured for its source, create the run — atomically.
 *
 * This is the business logic behind `POST /v1/webhooks/:source`. The Fastify
 * route stays thin: it authenticates, computes the dedupe key from the raw body,
 * and calls `ingest`. Everything transactional lives here.
 *
 * Two invariants are the database's, not this code's:
 *
 * 1. **Idempotency.** The event insert is `ON CONFLICT (tenant_id, source,
 *    dedupe_key) DO NOTHING`. A retried delivery collides on the unique
 *    constraint and creates neither a second event nor a second run — no
 *    application-level "check then insert" (which races) is involved.
 * 2. **One active workflow per (tenant, source).** The lookup for the active
 *    version filters on `is_active` and the extracted source; the partial unique
 *    index on `workflow_versions` guarantees that lookup can match at most one
 *    row, so routing is never ambiguous.
 *
 * The event and the run are created in one transaction: there is never an event
 * with a workflow configured but no run, nor a run without its event.
 */

import { and, desc, eq, sql } from 'drizzle-orm';

import { parseWorkflowDefinition } from '@/domain/workflow-definition.js';
import { buildRunContext } from '@/domain/workflow-run.js';
import { events, jobs, llmUsage, workflowRuns, workflowStepRuns, workflowVersions } from '@/db/schema.js';
import type { Event, Job, LlmUsage, WorkflowRun, WorkflowStepRun } from '@/db/schema.js';
import type { TransactionalJobEnqueuer } from '@/repositories/job-queue.js';
import { TenantScope, TenantScopedRepository } from '@/repositories/tenant-scope.js';

/** What the route hands the service for a single webhook delivery. */
export interface IngestInput {
  readonly source: string;
  readonly dedupeKey: string;
  readonly payload: unknown;
}

/** The outcome of ingestion, which the route maps to an HTTP response. */
export interface IngestResult {
  readonly eventId: string;
  /** The run created (or, for a duplicate, the one that already existed), else null. */
  readonly runId: string | null;
  /** True if this exact (source, dedupe_key) had already been ingested. */
  readonly duplicate: boolean;
  /** True if an active workflow matched the source and a run exists. */
  readonly workflowConfigured: boolean;
}

/** The capability the webhook route depends on. */
export interface WebhookIngestor {
  ingest(input: IngestInput): Promise<IngestResult>;
}

export class WebhookRepository extends TenantScopedRepository implements WebhookIngestor {
  /**
   * The queue is injected rather than constructed here so the first job is
   * created through the same code path — and defaults — as any other job, and
   * so ingestion depends on the *enqueue* capability, not on PostgreSQL queue
   * mechanics. It is invoked with this transaction so the event, the run and the
   * first job commit together or not at all.
   */
  constructor(
    scope: TenantScope,
    private readonly queue: TransactionalJobEnqueuer,
  ) {
    super(scope);
  }

  async ingest(input: IngestInput): Promise<IngestResult> {
    return this.db.transaction(async (tx) => {
      // Idempotent capture: a duplicate delivery inserts nothing and returns [].
      const inserted = await tx
        .insert(events)
        .values({
          tenantId: this.tenantId,
          source: input.source,
          dedupeKey: input.dedupeKey,
          payload: input.payload,
        })
        .onConflictDoNothing({
          target: [events.tenantId, events.source, events.dedupeKey],
        })
        .returning({ id: events.id });

      if (inserted.length === 0) {
        // Already ingested: report the existing event and its run (if any), and
        // create nothing new. Scoped to this tenant, so nothing leaks.
        const [existing] = await tx
          .select({ id: events.id })
          .from(events)
          .where(
            and(
              eq(events.tenantId, this.tenantId),
              eq(events.source, input.source),
              eq(events.dedupeKey, input.dedupeKey),
            ),
          );
        const eventId = existing!.id;
        const [run] = await tx
          .select({ id: workflowRuns.id })
          .from(workflowRuns)
          .where(and(eq(workflowRuns.tenantId, this.tenantId), eq(workflowRuns.eventId, eventId)));
        return {
          eventId,
          runId: run?.id ?? null,
          duplicate: true,
          workflowConfigured: run !== undefined,
        };
      }

      const eventId = inserted[0]!.id;

      // The single active webhook version for this tenant + source, if any. The
      // partial unique index guarantees at most one row.
      const [active] = await tx
        .select({
          id: workflowVersions.id,
          workflowId: workflowVersions.workflowId,
          definition: workflowVersions.definition,
        })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.tenantId, this.tenantId),
            eq(workflowVersions.isActive, true),
            eq(workflowVersions.triggerType, 'webhook'),
            sql`${workflowVersions.triggerConfig} ->> 'source' = ${input.source}`,
          ),
        );

      if (!active) {
        // Event is kept; no run. Not an error — the source simply has no workflow.
        return { eventId, runId: null, duplicate: false, workflowConfigured: false };
      }

      // Pin the exact version now; never re-resolve "active" later.
      const definition = parseWorkflowDefinition(active.definition);
      const firstStepKey = definition.steps[0]!.key;
      const context = buildRunContext({ source: input.source, eventId, payload: input.payload });

      const [run] = await tx
        .insert(workflowRuns)
        .values({
          tenantId: this.tenantId,
          workflowId: active.workflowId,
          workflowVersionId: active.id,
          eventId,
          status: 'queued',
          currentStepKey: firstStepKey,
          context: context as unknown as Record<string, unknown>,
        })
        .returning({ id: workflowRuns.id });

      // The first job, in the same transaction: there is never a queued run
      // without a job to advance it, nor a job for a run that failed to persist.
      // A duplicate delivery never reaches here (it returned above), so exactly
      // one first job is created per run.
      await this.queue.enqueue(
        { tenantId: this.tenantId, runId: run!.id, stepKey: firstStepKey },
        tx,
      );

      return { eventId, runId: run!.id, duplicate: false, workflowConfigured: true };
    });
  }

  /** Recent events for this tenant, newest first — a development inspection aid. */
  async listEvents(limit = 50): Promise<Event[]> {
    return this.db
      .select()
      .from(events)
      .where(this.scope.where(events.tenantId))
      .orderBy(desc(events.receivedAt))
      .limit(limit);
  }

  /** Recent workflow runs for this tenant, newest first. */
  async listRuns(limit = 50): Promise<WorkflowRun[]> {
    return this.db
      .select()
      .from(workflowRuns)
      .where(this.scope.where(workflowRuns.tenantId))
      .orderBy(desc(workflowRuns.createdAt))
      .limit(limit);
  }

  /** Recent jobs for this tenant, newest first — shows what the worker will pick up. */
  async listJobs(limit = 50): Promise<Job[]> {
    return this.db
      .select()
      .from(jobs)
      .where(this.scope.where(jobs.tenantId))
      .orderBy(desc(jobs.createdAt))
      .limit(limit);
  }

  /** Recent step runs for this tenant, newest first — the execution audit trail. */
  async listStepRuns(limit = 100): Promise<WorkflowStepRun[]> {
    return this.db
      .select()
      .from(workflowStepRuns)
      .where(this.scope.where(workflowStepRuns.tenantId))
      .orderBy(desc(workflowStepRuns.startedAt))
      .limit(limit);
  }

  /** Recent LLM usage records for this tenant, newest first — model/token/latency. */
  async listLlmUsage(limit = 100): Promise<LlmUsage[]> {
    return this.db
      .select()
      .from(llmUsage)
      .where(this.scope.where(llmUsage.tenantId))
      .orderBy(desc(llmUsage.createdAt))
      .limit(limit);
  }
}
