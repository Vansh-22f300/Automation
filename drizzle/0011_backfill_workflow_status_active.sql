-- Backfill: bring existing rows into the workflow-status invariant.
--
-- The lifecycle rule is now "a workflow with a runnable (active) version reads
-- `active`". Rows created before that rule can be `draft` while already owning an
-- active version — a stale display label the API/frontend surface. This corrects
-- exactly those rows and nothing else.
--
-- Idempotent: after the first run the affected rows are `active`, so the
-- `status = 'draft'` predicate matches none of them on any later run. `disabled`
-- rows are never touched (they are not `draft`); `draft` rows with no active
-- version keep their status; `workflow_versions` is only read, never written.
-- `updated_at` is set explicitly because it is maintained by the application
-- layer (Drizzle `$onUpdate`), not a database trigger, so raw SQL must bump it.
UPDATE "workflows" AS "w"
SET "status" = 'active', "updated_at" = now()
WHERE "w"."status" = 'draft'
  AND EXISTS (
    SELECT 1
    FROM "workflow_versions" AS "v"
    WHERE "v"."workflow_id" = "w"."id"
      AND "v"."tenant_id" = "w"."tenant_id"
      AND "v"."is_active" = true
  );
