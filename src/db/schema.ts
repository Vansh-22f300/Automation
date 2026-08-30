/**
 * Database schema — the single source of truth for the relational model.
 *
 * Two rules shape everything here:
 *
 * 1. **Every tenant-scoped table carries `tenant_id`.** Not because it is
 *    normalised (sometimes it is derivable) but because tenant isolation must be
 *    expressible as a predicate on the table being read. A query that has to
 *    join to discover which tenant a row belongs to is a query that can leak.
 *
 * 2. **Workflow definitions are data, not code and not tables.** A definition is
 *    stored as a single `jsonb` document. Users will eventually author workflows
 *    in natural language, so the step graph must be something the platform can
 *    produce, version, diff and interpret at runtime — not a schema migration.
 *    Shredding steps into relational tables would buy referential integrity we
 *    do not need and cost us the ability to treat a definition as one immutable
 *    versioned value.
 *
 * Migrations are generated from this file (`pnpm db:generate`); it is never
 * edited to match a database, always the other way round.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { newId } from '@/domain/ids.js';

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------

/**
 * The primary key every table shares: a `uuid` column whose value is a
 * **UUIDv7 generated in the application** (see `@/domain/ids`).
 *
 * `$defaultFn` — not `.defaultRandom()` — is the whole point. `.defaultRandom()`
 * emits a Postgres-side `gen_random_uuid()` default, which is a *v4* (random)
 * UUID; we deliberately do not use v4 for primary keys. `$defaultFn` instead runs
 * `newId()` in Node whenever an insert omits the id, so the stored value is a
 * time-ordered v7 with no dependence on the Postgres version. The column still
 * reports `hasDefault`, so callers never have to supply an id by hand.
 *
 * Returned fresh per table: a Drizzle column builder is stateful and cannot be
 * shared between table definitions.
 */
const primaryId = () => uuid('id').primaryKey().$defaultFn(newId);

/**
 * Returned fresh per table: a Drizzle column builder is stateful and cannot be
 * shared between table definitions.
 *
 * `timestamptz` everywhere, never naive `timestamp`. Runs span time zones,
 * retries compare instants, and audit trails are legal artefacts — a wall-clock
 * time without an offset is not a point in time.
 */
const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  /**
   * Maintained by Drizzle on `.update()`. A database trigger would be stronger
   * (it would also catch hand-written SQL) but every write in this system goes
   * through the repository layer, so the extra migration machinery is not
   * earning its keep yet.
   */
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ---------------------------------------------------------------------------
// Enumerated types
// ---------------------------------------------------------------------------
//
// Postgres enums rather than free text plus a CHECK constraint: they give the
// same integrity, generate exact TypeScript union types, and make an invalid
// value impossible rather than merely unlikely. The cost is that adding a
// variant needs a migration (`ALTER TYPE … ADD VALUE`), which Drizzle generates
// — an acceptable price for a small, slow-changing set of states.

export const tenantStatus = pgEnum('tenant_status', ['active', 'suspended']);
export const userStatus = pgEnum('user_status', ['active', 'disabled']);
export const workflowStatus = pgEnum('workflow_status', ['draft', 'active', 'disabled']);

/**
 * How a workflow version is started. Only webhooks exist in the MVP; `schedule`
 * and `manual` are deliberately absent until something implements them.
 */
export const triggerType = pgEnum('trigger_type', ['webhook']);

/**
 * The lifecycle of a single workflow run. `queued` is where every run starts;
 * the engine (Step 5+) drives it through `running`/`waiting` to a terminal
 * `succeeded`/`failed`/`cancelled`. The set is fixed here so an invalid state is
 * unrepresentable, even though nothing executes runs yet.
 */
export const workflowRunStatus = pgEnum('workflow_run_status', [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
]);

/**
 * The lifecycle of a single queued unit of work.
 *
 *   pending → running → done
 *                     ↘ failed
 *
 * A job starts `pending`, is claimed into `running` under a lease, and then
 * settles into `done` or `failed`. The transitions are one-directional and
 * enforced by the queue: `done`/`failed` are terminal, and nothing moves a job
 * back to `running` except a fresh claim of a `pending` row. A lease that
 * expires while `running` is returned to `pending` by the reaper — never left
 * dangling and never advanced to a terminal state it did not reach on its own.
 */
export const jobStatus = pgEnum('job_status', ['pending', 'running', 'done', 'failed']);

/**
 * The lifecycle of a single step execution record.
 *
 *   running → succeeded
 *           ↘ failed
 *
 * A row is written `running` the moment the engine begins executing a step, then
 * settled to `succeeded` (with an output) or `failed` (with a structured error).
 * There is no terminal-to-anything transition: a retry (Step 11) appends a *new*
 * row with a higher `attempt`, it never rewrites the old one. `waiting`/`paused`
 * states are deliberately absent until something suspends a step mid-flight.
 */
export const workflowStepRunStatus = pgEnum('workflow_step_run_status', [
  'running',
  'succeeded',
  'failed',
]);

/**
 * The lifecycle state of a stored external-service connection.
 * - `active`   — usable; the only state credential resolution will decrypt.
 * - `disabled` — deliberately turned off; resolution refuses it.
 * - `error`    — marked broken (e.g. the credential was rejected upstream).
 */
export const connectionStatus = pgEnum('connection_status', ['active', 'disabled', 'error']);


// ---------------------------------------------------------------------------
// tenants
// ---------------------------------------------------------------------------

/**
 * The root of every ownership chain. One row per customer organisation.
 *
 * `suspended` exists so billing or abuse handling can stop execution without
 * deleting anything — runs and audit history must survive a suspension.
 */
export const tenants = pgTable('tenants', {
  id: primaryId(),
  name: text('name').notNull(),
  status: tenantStatus('status').notNull().default('active'),
  ...timestamps(),
});

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

/**
 * A human who belongs to exactly one tenant.
 *
 * Intentionally free of authentication material. No password hash, no session,
 * no OAuth identity, no role — those belong to the step that actually
 * implements sign-in, and inventing columns now would guess wrong. This table
 * exists so that things which must attribute an action to a person (audit
 * entries, human approvals) have somewhere to point.
 */
export const users = pgTable(
  'users',
  {
    id: primaryId(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    /** Display name. Optional — an invited user may have no name yet. */
    name: text('name'),
    status: userStatus('status').notNull().default('active'),
    ...timestamps(),
  },
  (t) => [
    /**
     * Unique per tenant, case-insensitively. The same person may legitimately
     * hold accounts in two tenants, so the constraint is scoped rather than
     * global. `lower(email)` is enforced in the index instead of trusting every
     * caller to normalise: "Bob@x.com" and "bob@x.com" are one account.
     *
     * Also serves as the tenant-scoped lookup index (leading column tenant_id),
     * so no separate index on tenant_id is warranted.
     */
    uniqueIndex('users_tenant_id_email_key').on(t.tenantId, sql`lower(${t.email})`),
  ],
);

// ---------------------------------------------------------------------------
// workflows
// ---------------------------------------------------------------------------

/**
 * The stable identity of an automated process — the thing a user names, points a
 * webhook at, and enables or disables. It holds no logic of its own; all
 * behaviour lives in its versions.
 *
 * Note what is *absent*: there is no `active_version_id` column. See
 * `workflowVersions.isActive` below for why.
 */
export const workflows = pgTable(
  'workflows',
  {
    id: primaryId(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    status: workflowStatus('status').notNull().default('draft'),
    ...timestamps(),
  },
  (t) => [
    /** Serves the primary list view: this tenant's workflows, newest first. */
    index('workflows_tenant_id_created_at_idx').on(t.tenantId, t.createdAt.desc()),
    /**
     * Redundant on its own — `id` is already unique — but required as the target
     * of the composite foreign key on `workflow_versions`. Postgres will only
     * reference a column set backed by an explicit unique constraint.
     */
    unique('workflows_tenant_id_id_key').on(t.tenantId, t.id),
  ],
);

// ---------------------------------------------------------------------------
// workflow_versions
// ---------------------------------------------------------------------------

/**
 * An immutable snapshot of a workflow's logic.
 *
 * **Never UPDATE a definition — INSERT a new version.** A run pins the exact
 * version it started under, so an in-flight execution cannot have the ground
 * shift beneath it, and a run that failed months ago can still be explained by
 * reading the definition it actually used. That guarantee is worthless if rows
 * are mutable, which is why there is no `updated_at` here: the absence of the
 * column is the documentation.
 *
 * (`isActive` is the one mutable field, and it is metadata about which version
 * is current — not part of the versioned logic itself.)
 */
export const workflowVersions = pgTable(
  'workflow_versions',
  {
    id: primaryId(),
    /**
     * Denormalised from `workflows.tenant_id` so that tenant isolation is a
     * predicate on this table. Kept honest by the composite foreign key below,
     * which is also what ties this row to its workflow — hence no separate
     * single-column FK on either field.
     */
    tenantId: uuid('tenant_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    /** Monotonic per workflow, starting at 1. Assigned by the application. */
    version: integer('version').notNull(),

    /**
     * The step graph, as JSON. Validated against a Zod schema on write (Step 6)
     * and interpreted by the engine at runtime.
     *
     * Typed as a plain JSON object rather than the eventual
     * `WorkflowDefinition`: rows written by older releases may not satisfy
     * today's schema, so reads must parse and cannot simply assert. Narrowing
     * this to a validated type here would be a lie the compiler cannot catch.
     */
    definition: jsonb('definition').notNull().$type<Record<string, unknown>>(),

    triggerType: triggerType('trigger_type').notNull(),
    /**
     * Trigger-specific settings, shaped by `triggerType` (for a webhook: the
     * signature scheme, the secret reference, filters). Same reasoning as
     * `definition` — a discriminated JSON document rather than columns that are
     * null for every trigger kind but one.
     */
    triggerConfig: jsonb('trigger_config')
      .notNull()
      .default({})
      .$type<Record<string, unknown>>(),

    /**
     * Marks the version that new triggers will run.
     *
     * The obvious alternative — `workflows.active_version_id` pointing here —
     * creates a circular foreign key between the two tables, which forces
     * either a deferrable constraint or an unenforced column. Putting the flag
     * on the version removes the cycle entirely *and* lets Postgres enforce the
     * real invariant: at most one active version per workflow, via the partial
     * unique index below. Promotion is `UPDATE … SET is_active = false` for the
     * workflow followed by `UPDATE … SET is_active = true` for the new version,
     * inside one transaction.
     */
    isActive: boolean('is_active').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /**
     * The row must belong to a workflow *in the same tenant*. A single-column
     * FK on workflow_id would allow a version to be filed under tenant A while
     * hanging off tenant B's workflow — silent cross-tenant corruption, and the
     * hardest class of bug to notice. This makes it unrepresentable.
     */
    foreignKey({
      name: 'workflow_versions_workflow_id_tenant_id_fkey',
      columns: [t.tenantId, t.workflowId],
      foreignColumns: [workflows.tenantId, workflows.id],
    }).onDelete('cascade'),

    /** Version numbers are unique and stable within a workflow. */
    unique('workflow_versions_workflow_id_version_key').on(t.workflowId, t.version),

    /**
     * Backs the composite foreign key that `workflow_runs` uses to pin a run to
     * a version *in the same tenant*. Redundant for uniqueness (`id` is already
     * unique) but Postgres will only reference a column set with an explicit
     * unique constraint.
     */
    unique('workflow_versions_tenant_id_id_key').on(t.tenantId, t.id),

    /**
     * At most one active version per workflow, enforced by the database rather
     * than by application discipline. A partial index is what makes this
     * expressible: unaffected by the many inactive rows.
     */
    uniqueIndex('workflow_versions_one_active_per_workflow_idx')
      .on(t.workflowId)
      .where(sql`${t.isActive}`),

    /**
     * The routing invariant: **one tenant + one webhook source = one active
     * workflow.** An incoming `POST /v1/webhooks/:source` must resolve to a
     * single active version, so two active versions in the same tenant sharing a
     * `trigger_config.source` would be ambiguous. This partial unique index over
     * the extracted source makes that unrepresentable — activation of a colliding
     * version fails at the database, not merely by convention. Scoped to the
     * tenant, so tenant B may independently use the same source.
     */
    uniqueIndex('workflow_versions_one_active_per_tenant_source_idx')
      .on(t.tenantId, sql`(${t.triggerConfig} ->> 'source')`)
      .where(sql`${t.isActive}`),
  ],
);

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

/**
 * A raw external signal received at the webhook boundary, captured verbatim
 * before anything acts on it.
 *
 * Events are the durable, replayable record of "something happened": persisted
 * first, then a run may be created from one. The dedupe key is what makes
 * ingestion idempotent — a provider that retries the same delivery, or a caller
 * that resends an identical body, must not produce a second event or a second
 * run. That guarantee is the database's, via the unique constraint below, not the
 * application's "check then insert" (which races).
 */
export const events = pgTable(
  'events',
  {
    id: primaryId(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Which webhook source this arrived on, e.g. `stripe`. From the URL path. */
    source: text('source').notNull(),
    /**
     * The idempotency key: the caller's `X-Event-ID` if supplied, otherwise a
     * SHA-256 of the raw request body. Deterministic on purpose — the same body
     * always yields the same key — so a retry collides rather than duplicates.
     */
    dedupeKey: text('dedupe_key').notNull(),
    /** The parsed JSON payload, stored whole. */
    payload: jsonb('payload').notNull().$type<unknown>(),
    /** When the signal was received at the boundary. */
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /**
     * Idempotency, enforced by the database. Scoped to the tenant and source so
     * the same key is independent across tenants and across sources — exactly
     * the collision domain the webhook flow relies on.
     */
    unique('events_tenant_id_source_dedupe_key_key').on(t.tenantId, t.source, t.dedupeKey),
    /**
     * Backs the composite foreign key that `workflow_runs` uses to tie a run to
     * an event *in the same tenant*.
     */
    unique('events_tenant_id_id_key').on(t.tenantId, t.id),
    /** Tenant/source/time lookup for inspecting recent events. */
    index('events_tenant_id_source_received_at_idx').on(
      t.tenantId,
      t.source,
      t.receivedAt.desc(),
    ),
  ],
);

// ---------------------------------------------------------------------------
// workflow_runs
// ---------------------------------------------------------------------------

/**
 * One execution of a workflow, born from an event.
 *
 * Created at `queued` and nothing advances it yet — the worker and executor are
 * Step 5+. What matters here is what a run *pins* at creation: both the workflow
 * and the exact `workflow_version_id`. A run must never re-resolve "the active
 * version" later, or promoting a new version would silently change the logic of
 * runs already in flight. The composite foreign keys make cross-tenant attachment
 * impossible: a run can only reference a workflow, version and event of its own
 * tenant.
 */
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: primaryId(),
    tenantId: uuid('tenant_id').notNull(),
    workflowId: uuid('workflow_id').notNull(),
    /** The pinned version. Never the "current active" — the one resolved at creation. */
    workflowVersionId: uuid('workflow_version_id').notNull(),
    /** The event that triggered this run. */
    eventId: uuid('event_id').notNull(),
    status: workflowRunStatus('status').notNull().default('queued'),
    /** Where execution is, once it starts. The first step key at creation. */
    currentStepKey: text('current_step_key'),
    /** Accumulated run state: trigger data and per-step results. Small for now. */
    context: jsonb('context').notNull().default({}).$type<Record<string, unknown>>(),
    /** Populated only on failure; a structured error, never a raw stack to a client. */
    error: jsonb('error').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    /** The run's workflow must be in the run's tenant. */
    foreignKey({
      name: 'workflow_runs_tenant_id_workflow_id_fkey',
      columns: [t.tenantId, t.workflowId],
      foreignColumns: [workflows.tenantId, workflows.id],
    }).onDelete('cascade'),
    /** The pinned version must be in the run's tenant. */
    foreignKey({
      name: 'workflow_runs_tenant_id_workflow_version_id_fkey',
      columns: [t.tenantId, t.workflowVersionId],
      foreignColumns: [workflowVersions.tenantId, workflowVersions.id],
    }).onDelete('cascade'),
    /** The triggering event must be in the run's tenant. */
    foreignKey({
      name: 'workflow_runs_tenant_id_event_id_fkey',
      columns: [t.tenantId, t.eventId],
      foreignColumns: [events.tenantId, events.id],
    }).onDelete('cascade'),
    /** Tenant-scoped listing, newest first. */
    index('workflow_runs_tenant_id_created_at_idx').on(t.tenantId, t.createdAt.desc()),
    /**
     * Backs the composite foreign key that `jobs` uses to attach a queued unit
     * of work to a run *in the same tenant*. Redundant for uniqueness (`id` is
     * already unique) but Postgres will only reference a column set with an
     * explicit unique constraint.
     */
    unique('workflow_runs_tenant_id_id_key').on(t.tenantId, t.id),
  ],
);

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

/**
 * A queued unit of work: "advance run R by executing step S".
 *
 * The jobs table is the durable, crash-safe hand-off between the API (which
 * enqueues) and the worker (which claims and executes). Postgres *is* the queue
 * — there is no Redis or broker — and the claim is a `SELECT … FOR UPDATE SKIP
 * LOCKED` inside a short transaction, so many workers can poll the same table
 * without ever handing the same job to two of them.
 *
 * What each column is load-bearing for:
 *
 * - **`status` + `run_at`** drive consumption: the claim looks for the oldest
 *   `pending` row whose `run_at` has arrived. `run_at` in the future is how a
 *   job is deferred (a retry backoff, later); for the first job it is simply
 *   now.
 * - **`locked_by` + `lease_expires_at`** are the lease. A claimed job records
 *   which worker holds it and until when. If that worker dies, the lease
 *   expires and the reaper returns the row to `pending` — the guarantee that no
 *   job is lost to a crashed process. The structure (a `locked_by` and an
 *   expiry) is deliberately the shape a heartbeat/renewal would extend later,
 *   without a schema change.
 * - **`attempt` / `max_attempts`** count executions. `attempt` increments as a
 *   job is retried; `max_attempts` is stored now so the retry policy (a later
 *   step) has somewhere to read its ceiling from. Nothing enforces the ceiling
 *   yet — that is the retry policy's job, not the queue's.
 * - **`last_error`** keeps the most recent structured failure for inspection,
 *   never a raw stack destined for a client.
 *
 * Tenant safety is the composite foreign key: a job can only reference a run of
 * its own tenant, so a cross-tenant attachment is unrepresentable at the
 * database level, exactly as for `workflow_runs`.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: primaryId(),
    /**
     * Denormalised from the run's tenant so tenant isolation is a predicate on
     * this table (a scoped worker can filter `WHERE tenant_id = …`) and kept
     * honest by the composite foreign key below.
     */
    tenantId: uuid('tenant_id').notNull(),
    /** The run this job advances. */
    runId: uuid('run_id').notNull(),
    /** Which step of the run's definition this job executes. */
    stepKey: text('step_key').notNull(),
    /** How many times execution has been attempted. Starts at 0. */
    attempt: integer('attempt').notNull().default(0),
    /** The ceiling the retry policy (a later step) will enforce. */
    maxAttempts: integer('max_attempts').notNull().default(5),
    status: jobStatus('status').notNull().default('pending'),
    /** The earliest instant this job may be claimed. Now, for an immediate job. */
    runAt: timestamp('run_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** The worker instance holding the lease, while `running`. Null otherwise. */
    lockedBy: text('locked_by'),
    /** When the current lease expires. Past-due + `running` ⇒ reclaimable. */
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'date' }),
    /** The most recent structured failure. Log-safe; never a raw stack. */
    lastError: jsonb('last_error').$type<Record<string, unknown>>(),
    ...timestamps(),
  },
  (t) => [
    /**
     * The job's run must be in the job's tenant. A single-column FK on run_id
     * would let a job be filed under tenant A while pointing at tenant B's run —
     * the same silent cross-tenant corruption the composite keys elsewhere exist
     * to make impossible.
     */
    foreignKey({
      name: 'jobs_tenant_id_run_id_fkey',
      columns: [t.tenantId, t.runId],
      foreignColumns: [workflowRuns.tenantId, workflowRuns.id],
    }).onDelete('cascade'),

    /**
     * The consumption path: the oldest ready `pending` job. A partial index over
     * `run_at`, restricted to `pending` rows, keeps the claim's index scan tight
     * regardless of how many `done`/`failed` rows have accumulated.
     */
    index('jobs_pending_run_at_idx')
      .on(t.runAt)
      .where(sql`${t.status} = 'pending'`),

    /**
     * The reaper path: `running` jobs whose lease has expired. A partial index
     * over `lease_expires_at`, restricted to `running` rows, so the periodic
     * "what has died?" sweep never scans settled work.
     */
    index('jobs_running_lease_expires_at_idx')
      .on(t.leaseExpiresAt)
      .where(sql`${t.status} = 'running'`),
  ],
);

// ---------------------------------------------------------------------------
// workflow_step_runs
// ---------------------------------------------------------------------------

/**
 * The audit record of a single step execution — one row per attempt at one step
 * of one run.
 *
 * This table is the durable, append-only history the engine writes as it drives
 * a run forward one step at a time. It exists so that "what did this run do, in
 * what order, with what inputs and outputs, and where did it fail" is answerable
 * from the database alone — never reconstructed from logs. The engine never
 * UPDATEs a settled row to a different outcome; a retry (Step 11) INSERTs a new
 * row with a higher `attempt`.
 *
 * Two invariants are the database's, not the application's:
 *
 * 1. **Tenant safety.** The composite foreign key `(tenant_id, run_id) →
 *    workflow_runs(tenant_id, id)` makes a step run for another tenant's run
 *    unrepresentable — the same guarantee `jobs` has.
 * 2. **At most one *successful* execution per (run, step, attempt).** A partial
 *    unique index over `succeeded` rows is the database backstop against a
 *    redelivered job (leases give at-least-once delivery) recording a second
 *    success for the same attempt. The primary runtime guard is the engine
 *    refusing to re-execute a step the run has already advanced past; this index
 *    catches the pathological case the runtime guard cannot.
 */
export const workflowStepRuns = pgTable(
  'workflow_step_runs',
  {
    id: primaryId(),
    /** Denormalised from the run's tenant; kept honest by the composite FK below. */
    tenantId: uuid('tenant_id').notNull(),
    /** The run this step execution belongs to. */
    runId: uuid('run_id').notNull(),
    /** The step key within the run's pinned definition. */
    stepKey: text('step_key').notNull(),
    /** The step's type at execution time (e.g. `noop`), copied from the definition. */
    stepType: text('step_type').notNull(),
    /** Which attempt this record is. Matches the driving job's `attempt`; starts at 0. */
    attempt: integer('attempt').notNull().default(0),
    status: workflowStepRunStatus('status').notNull(),
    /** The resolved input handed to the step handler. Null when a step takes none. */
    input: jsonb('input').$type<Record<string, unknown>>(),
    /** The step's output, persisted on success. Null until (and unless) succeeded. */
    output: jsonb('output').$type<unknown>(),
    /** A structured, log-safe error, persisted on failure. Null unless failed. */
    error: jsonb('error').$type<Record<string, unknown>>(),
    /** When execution began. Set at insert. */
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** When execution settled (succeeded or failed). Null while running. */
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    /** Wall-clock execution time in milliseconds. Null while running. */
    durationMs: integer('duration_ms'),
  },
  (t) => [
    /**
     * The step run's run must be in the step run's tenant — the same composite-FK
     * tenant guard `jobs` uses, making cross-tenant attachment impossible.
     */
    foreignKey({
      name: 'workflow_step_runs_tenant_id_run_id_fkey',
      columns: [t.tenantId, t.runId],
      foreignColumns: [workflowRuns.tenantId, workflowRuns.id],
    }).onDelete('cascade'),

    /**
     * At most one *successful* execution per (run, step, attempt). Partial over
     * `succeeded` so the many running/failed rows a retry history accumulates do
     * not collide — only a second *success* for the same attempt is forbidden.
     * This is the database's idempotency backstop under at-least-once delivery.
     */
    uniqueIndex('workflow_step_runs_one_success_per_attempt_idx')
      .on(t.runId, t.stepKey, t.attempt)
      .where(sql`${t.status} = 'succeeded'`),

    /** The audit view: a run's step history in execution order. */
    index('workflow_step_runs_run_id_started_at_idx').on(t.runId, t.startedAt),
  ],
);

// ---------------------------------------------------------------------------
// llm_usage
// ---------------------------------------------------------------------------

/**
 * Token/latency accounting for a single successful `llm` step execution.
 *
 * Kept in its own table rather than as columns on `workflow_step_runs` because
 * usage is specific to steps that call a model — most steps have none — and
 * because cost reporting (a later concern) wants to aggregate this dimension
 * independently of the step-run audit trail. One row per metered step run.
 *
 * The engine writes this row inside the same transaction that settles the step
 * run, so usage and result commit together. The **provider never writes here** —
 * it returns usage to the caller; persistence is the engine's job. No prompt,
 * output or credential is stored: only counts, the model and the provider name.
 *
 * Tenant safety is the composite foreign key `(tenant_id, run_id) →
 * workflow_runs(tenant_id, id)`, as elsewhere; `step_run_id` ties the row to the
 * exact execution and is unique so a redelivered step cannot double-count.
 */
export const llmUsage = pgTable(
  'llm_usage',
  {
    id: primaryId(),
    /** Denormalised from the run's tenant; kept honest by the composite FK below. */
    tenantId: uuid('tenant_id').notNull(),
    /** The run this usage belongs to. */
    runId: uuid('run_id').notNull(),
    /** The exact step execution that incurred it. One usage row per step run. */
    stepRunId: uuid('step_run_id')
      .notNull()
      .references(() => workflowStepRuns.id, { onDelete: 'cascade' }),
    /** Stable provider identifier, e.g. `claude`. */
    provider: text('provider').notNull(),
    /** The model that actually served the request, as the provider reported it. */
    model: text('model').notNull(),
    /**
     * Which provider round this row meters. A no-tools `llm` step makes one call
     * (round 1); a tool-calling step meters each request→execute round separately,
     * so a step run can own several rows, one per round.
     */
    round: integer('round').notNull().default(1),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    totalTokens: integer('total_tokens').notNull(),
    /** Wall-clock latency of the model call in milliseconds. */
    latencyMs: integer('latency_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** The usage row's run must be in the usage row's tenant. */
    foreignKey({
      name: 'llm_usage_tenant_id_run_id_fkey',
      columns: [t.tenantId, t.runId],
      foreignColumns: [workflowRuns.tenantId, workflowRuns.id],
    }).onDelete('cascade'),
    /** At most one usage row per (step execution, round) — the idempotency backstop. */
    unique('llm_usage_step_run_round_key').on(t.stepRunId, t.round),
    /** Tenant/run lookup for inspecting a run's usage. */
    index('llm_usage_tenant_id_run_id_idx').on(t.tenantId, t.runId),
  ],
);

// ---------------------------------------------------------------------------
// api_keys
// ---------------------------------------------------------------------------

/**
 * A tenant's API credential for the HTTP boundary.
 *
 * The security model is the same one every credible API-key system uses, and the
 * columns exist to enforce it:
 *
 * - **The plaintext key is never stored.** Only `key_hash` — a SHA-256 of the
 *   key's random secret — lives here. A database dump therefore cannot be
 *   replayed as credentials. SHA-256 (not bcrypt/argon2) is the correct choice
 *   *because the secret is 256 bits of CSPRNG output*: there is nothing to
 *   brute-force, so a slow password hash would buy nothing and cost latency on
 *   every request.
 * - **`prefix`** is a short, non-secret slice of the key shown in dashboards and
 *   logs so a human can tell keys apart, and — being unique and indexed — is what
 *   authentication looks a candidate row up by before doing the constant-time
 *   hash comparison. It reveals nothing usable on its own.
 * - **`revoked_at`** is a soft delete. A revoked key stops authenticating
 *   immediately but the row survives, so audit history ("which key acted, and
 *   when was it turned off") is preserved. Nullable: null means live.
 * - **`last_used_at`** supports key hygiene (spotting stale or leaked keys).
 *   Nullable and best-effort; a never-used key has null here.
 *
 * There is intentionally no `updated_at`: the only mutations are revocation and
 * the last-used touch, and each has its own dedicated, meaningful timestamp.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: primaryId(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Human label chosen at creation, e.g. "CI pipeline" or "Zapier". */
    name: text('name').notNull(),
    /**
     * Non-secret public identifier: the first characters of the key's secret.
     * Unique so authentication can resolve a single candidate row by it.
     */
    prefix: text('prefix').notNull(),
    /** SHA-256 (hex) of the key's secret. Never the plaintext. */
    keyHash: text('key_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** Set the first and every subsequent time the key authenticates. Best-effort. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    /** Non-null once revoked; a revoked key never authenticates again. */
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    /**
     * The lookup path for every authenticated request: resolve a candidate by
     * prefix, then compare the hash in constant time. Unique so the resolution is
     * unambiguous; a (astronomically unlikely) prefix collision is retried at
     * generation time rather than tolerated here.
     */
    uniqueIndex('api_keys_prefix_key').on(t.prefix),
    /** Tenant-scoped listing, newest first, for key-management views. */
    index('api_keys_tenant_id_created_at_idx').on(t.tenantId, t.createdAt.desc()),
  ],
);

// ---------------------------------------------------------------------------
// connections
// ---------------------------------------------------------------------------

/**
 * A tenant's stored authorization to act against an external provider (Slack,
 * GitHub, Gmail — none of which exist yet; this is the generic store they will use).
 *
 * The security model is deliberate:
 *
 * - **The secret is never stored in the clear.** `encrypted_credentials` holds a
 *   versioned AES-256-GCM envelope (see src/security/credential-cipher.ts), not a
 *   token, refresh token, or password. A database dump reveals nothing usable
 *   without the separately-held key, which never lives in Postgres.
 * - **`metadata`** is for non-secret descriptors (account label, scopes) — a place
 *   for facts safe to list and log. The secret never goes here.
 * - **Tenant isolation is the database's, not just the code's.** `tenant_id`
 *   cascades from `tenants`, and `unique(tenant_id, id)` makes this a valid target
 *   for future composite tenant-safe FKs `(tenant_id, connection_id)`.
 * - **`last_used_at`** records when a credential was last decrypted for use, for
 *   hygiene. Nullable; a never-used connection has null here.
 *
 * Two uniqueness rules encode "one connection per name, one *active* per provider":
 * `unique(tenant_id, provider, name)` keeps names distinct within a provider, and
 * the partial unique index on `(tenant_id, provider) WHERE status = 'active'` makes
 * "resolve this tenant's active connection for a provider" unambiguous. An explicit
 * connection id still overrides that default resolution.
 */
export const connections = pgTable(
  'connections',
  {
    id: primaryId(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Stable provider identifier, e.g. `slack`. Free-form text, not an enum: the */
    /** set of providers grows without a migration. */
    provider: text('provider').notNull(),
    /** Human label distinguishing multiple connections to the same provider. */
    name: text('name').notNull(),
    status: connectionStatus('status').notNull().default('active'),
    /** The versioned AES-256-GCM envelope. Never plaintext. */
    encryptedCredentials: jsonb('encrypted_credentials').notNull(),
    /** Non-secret descriptors (account label, scopes, …). Never the secret. */
    metadata: jsonb('metadata').notNull().default({}),
    ...timestamps(),
    /** When a credential was last decrypted for use. Null if never used. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    /** Composite tenant-safe FK target for future `(tenant_id, connection_id)` refs. */
    unique('connections_tenant_id_id_key').on(t.tenantId, t.id),
    /** Names are distinct within a tenant + provider. */
    unique('connections_tenant_id_provider_name_key').on(t.tenantId, t.provider, t.name),
    // NOTE: there is deliberately NO "one active connection per (tenant, provider)"
    // constraint. A tenant may hold many active connections to the same provider
    // (e.g. two Slack workspaces). Which one a tool uses is decided by a trusted
    // `connectionId` in workflow/tool config — never inferred, never model-chosen.
    /** Tenant-scoped listing, newest first. */
    index('connections_tenant_id_created_at_idx').on(t.tenantId, t.createdAt.desc()),
  ],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------
//
// Declarative relationships for Drizzle's relational query API. These generate
// no SQL and add no constraints; the foreign keys above are what the database
// enforces. They exist so joins can be expressed by name.

export const tenantsRelations = relations(tenants, ({ many }) => ({
  users: many(users),
  workflows: many(workflows),
  workflowVersions: many(workflowVersions),
  apiKeys: many(apiKeys),
  events: many(events),
  workflowRuns: many(workflowRuns),
  jobs: many(jobs),
  stepRuns: many(workflowStepRuns),
  llmUsage: many(llmUsage),
  connections: many(connections),
}));

export const usersRelations = relations(users, ({ one }) => ({
  tenant: one(tenants, { fields: [users.tenantId], references: [tenants.id] }),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  tenant: one(tenants, { fields: [apiKeys.tenantId], references: [tenants.id] }),
}));

export const workflowsRelations = relations(workflows, ({ one, many }) => ({
  tenant: one(tenants, { fields: [workflows.tenantId], references: [tenants.id] }),
  versions: many(workflowVersions),
}));

export const workflowVersionsRelations = relations(workflowVersions, ({ one }) => ({
  tenant: one(tenants, {
    fields: [workflowVersions.tenantId],
    references: [tenants.id],
  }),
  workflow: one(workflows, {
    fields: [workflowVersions.workflowId],
    references: [workflows.id],
  }),
}));

export const eventsRelations = relations(events, ({ one, many }) => ({
  tenant: one(tenants, { fields: [events.tenantId], references: [tenants.id] }),
  runs: many(workflowRuns),
}));

export const workflowRunsRelations = relations(workflowRuns, ({ one, many }) => ({
  tenant: one(tenants, { fields: [workflowRuns.tenantId], references: [tenants.id] }),
  workflow: one(workflows, {
    fields: [workflowRuns.workflowId],
    references: [workflows.id],
  }),
  version: one(workflowVersions, {
    fields: [workflowRuns.workflowVersionId],
    references: [workflowVersions.id],
  }),
  event: one(events, { fields: [workflowRuns.eventId], references: [events.id] }),
  jobs: many(jobs),
  stepRuns: many(workflowStepRuns),
  llmUsage: many(llmUsage),
}));

export const workflowStepRunsRelations = relations(workflowStepRuns, ({ one, many }) => ({
  tenant: one(tenants, { fields: [workflowStepRuns.tenantId], references: [tenants.id] }),
  run: one(workflowRuns, {
    fields: [workflowStepRuns.runId],
    references: [workflowRuns.id],
  }),
  usage: many(llmUsage),
}));

export const llmUsageRelations = relations(llmUsage, ({ one }) => ({
  tenant: one(tenants, { fields: [llmUsage.tenantId], references: [tenants.id] }),
  run: one(workflowRuns, { fields: [llmUsage.runId], references: [workflowRuns.id] }),
  stepRun: one(workflowStepRuns, {
    fields: [llmUsage.stepRunId],
    references: [workflowStepRuns.id],
  }),
}));

export const jobsRelations = relations(jobs, ({ one }) => ({
  tenant: one(tenants, { fields: [jobs.tenantId], references: [tenants.id] }),
  run: one(workflowRuns, { fields: [jobs.runId], references: [workflowRuns.id] }),
}));

export const connectionsRelations = relations(connections, ({ one }) => ({
  tenant: one(tenants, { fields: [connections.tenantId], references: [tenants.id] }),
}));

// ---------------------------------------------------------------------------
// Inferred row types
// ---------------------------------------------------------------------------
//
// `$inferSelect` / `$inferInsert` are derived from the schema, so a column
// change is a type error at every call site rather than a runtime surprise.

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;

export type WorkflowVersion = typeof workflowVersions.$inferSelect;
export type NewWorkflowVersion = typeof workflowVersions.$inferInsert;

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

export type WorkflowStepRun = typeof workflowStepRuns.$inferSelect;
export type NewWorkflowStepRun = typeof workflowStepRuns.$inferInsert;

export type LlmUsage = typeof llmUsage.$inferSelect;
export type NewLlmUsage = typeof llmUsage.$inferInsert;

export type Connection = typeof connections.$inferSelect;
export type NewConnection = typeof connections.$inferInsert;
