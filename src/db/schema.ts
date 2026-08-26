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

// ---------------------------------------------------------------------------
// Shared column helpers
// ---------------------------------------------------------------------------

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
  id: uuid('id').primaryKey().defaultRandom(),
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
    id: uuid('id').primaryKey().defaultRandom(),
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
    id: uuid('id').primaryKey().defaultRandom(),
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
    id: uuid('id').primaryKey().defaultRandom(),
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
     * At most one active version per workflow, enforced by the database rather
     * than by application discipline. A partial index is what makes this
     * expressible: unaffected by the many inactive rows.
     */
    uniqueIndex('workflow_versions_one_active_per_workflow_idx')
      .on(t.workflowId)
      .where(sql`${t.isActive}`),
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
}));

export const usersRelations = relations(users, ({ one }) => ({
  tenant: one(tenants, { fields: [users.tenantId], references: [tenants.id] }),
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
