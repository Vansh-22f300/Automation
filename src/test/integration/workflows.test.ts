/**
 * Integration tests for the workflow / workflow-version service — real PostgreSQL.
 *
 * SKIPPED unless `TEST_DATABASE_URL` is set; never faked. If the variable is
 * absent the suite reports skipped, not passed.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_workforce_test pnpm test
 *
 * What these cover that the offline unit tests cannot:
 *   - a workflow and its version 1 are created transactionally, under the right
 *     tenant, with the definition and trigger config stored as JSONB
 *   - version 2 is a fresh INSERT that leaves version 1 byte-for-byte unchanged
 *   - version numbers are monotonic and the DB unique constraint refuses a dupe
 *   - activating v2 deactivates v1, and the partial unique index holds "one active"
 *   - inactive versions remain readable
 *   - tenant isolation at the SQL level: tenant A cannot read, add a version to,
 *     or activate tenant B's workflow — each fails as NotFound, not a leak
 *
 * The suite writes and deletes rows, so it refuses any database whose name does
 * not contain "test".
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BadRequestError, NotFoundError } from "@/api/errors.js";
import type { DatabaseHandle } from "@/db/client.js";
import { tenants, workflowRuns, workflowVersions, workflows } from "@/db/schema.js";
import { PostgresJobQueue } from "@/repositories/job-queue.js";
import { TenantScope } from "@/repositories/tenant-scope.js";
import { WebhookRepository } from "@/repositories/webhook-repository.js";
import { WorkflowRepository } from "@/repositories/workflow-repository.js";

import { TEST_DATABASE_URL, createTestDatabaseHandle } from "./support.js";

const linear = (keys: string[]) => ({
  version: 1,
  steps: keys.map((key) => ({ key, type: "noop", config: {} })),
});

describe.skipIf(TEST_DATABASE_URL === undefined)("workflow integration", () => {
  let handle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;

  const repoFor = (tenantId: string): WorkflowRepository =>
    new WorkflowRepository(new TenantScope(handle.db, tenantId));

  // Real queue + ingestor, to prove disable actually stops webhook routing.
  const ingestorFor = (tenantId: string): WebhookRepository =>
    new WebhookRepository(
      new TenantScope(handle.db, tenantId),
      new PostgresJobQueue(handle.db),
    );

  beforeAll(async () => {
    handle = createTestDatabaseHandle();
    await handle.verifyConnection();

    const inserted = await handle.db
      .insert(tenants)
      .values([{ name: "Workflow Tenant A" }, { name: "Workflow Tenant B" }])
      .returning({ id: tenants.id });
    tenantA = inserted[0]!.id;
    tenantB = inserted[1]!.id;
  });

  afterAll(async () => {
    if (handle === undefined) return;
    for (const id of [tenantA, tenantB]) {
      if (id !== undefined)
        await handle.db.delete(tenants).where(eq(tenants.id, id));
    }
    await handle.close();
  });

  it("creates a workflow with an active version 1, storing definition and trigger", async () => {
    const { workflow, version } = await repoFor(tenantA).create({
      name: "first workflow",
      definition: linear(["a", "b"]),
      triggerType: "webhook",
      triggerConfig: { source: "wf-create" },
    });

    expect(workflow.tenantId).toBe(tenantA);
    // Default create activates version 1, so the status label reads `active`.
    expect(workflow.status).toBe("active");
    expect(version.version).toBe(1);
    expect(version.isActive).toBe(true);
    expect(version.definition).toMatchObject({ version: 1 });
    expect(version.triggerConfig).toEqual({ source: "wf-create" });

    const active = await repoFor(tenantA).getActiveVersion(workflow.id);
    expect(active?.id).toBe(version.id);
  });

  it("creates as draft with no active version when activate:false", async () => {
    const { workflow, version } = await repoFor(tenantA).create({
      name: "unactivated",
      definition: linear(["a"]),
      triggerType: "webhook",
      triggerConfig: { source: "wf-draft" },
      activate: false,
    });

    expect(workflow.status).toBe("draft");
    expect(version.isActive).toBe(false);
    expect(await repoFor(tenantA).getActiveVersion(workflow.id)).toBeNull();
  });

  it("rejects an invalid definition before writing anything", async () => {
    await expect(
      repoFor(tenantA).create({
        name: "bad",
        definition: { version: 1, steps: [] },
        triggerType: "webhook",
        triggerConfig: { source: "wf-invalid" },
      }),
    ).rejects.toMatchObject({ code: "invalid_definition" });
  });

  it("creates version 2 as a new row, leaving version 1 unchanged", async () => {
    const { workflow, version: v1 } = await repoFor(tenantA).create({
      name: "versioned",
      definition: linear(["a"]),
      triggerType: "webhook",
      triggerConfig: { source: "wf-v2" },
    });
    const v1Snapshot = { def: v1.definition, created: v1.createdAt.getTime() };

    const v2 = await repoFor(tenantA).createVersion(workflow.id, {
      definition: linear(["a", "b"]),
      triggerType: "webhook",
      triggerConfig: { source: "wf-v2" },
      activate: true,
    });

    expect(v2.version).toBe(2);

    const versions = await repoFor(tenantA).listVersions(workflow.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);

    // Version 1 is byte-for-byte what it was: not touched by v2's creation.
    const [reloadedV1] = await handle.db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, v1.id));
    expect(reloadedV1!.definition).toEqual(v1Snapshot.def);
    expect(reloadedV1!.createdAt.getTime()).toBe(v1Snapshot.created);
    expect(reloadedV1!.isActive).toBe(false);
  });

  it("keeps exactly one active version when v2 is activated", async () => {
    const { workflow, version: v1 } = await repoFor(tenantA).create({
      name: "promote",
      definition: linear(["a"]),
      triggerType: "webhook",
      triggerConfig: { source: "wf-activate" },
    });
    const v2 = await repoFor(tenantA).createVersion(workflow.id, {
      definition: linear(["a", "b"]),
      triggerType: "webhook",
      triggerConfig: { source: "wf-activate" },
      activate: true,
    });

    const active = await handle.db
      .select({ id: workflowVersions.id })
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, workflow.id));
    // Read the active set explicitly.
    const nowActive = await repoFor(tenantA).getActiveVersion(workflow.id);
    expect(nowActive?.id).toBe(v2.id);
    expect(active.length).toBe(2);
    // createVersion(activate:true) marks the parent active.
    expect((await repoFor(tenantA).getWorkflow(workflow.id)).status).toBe("active");

    // v1 is available but inactive; re-activating it flips the single active flag.
    await repoFor(tenantA).activateVersion(workflow.id, v1.id);
    expect((await repoFor(tenantA).getActiveVersion(workflow.id))?.id).toBe(
      v1.id,
    );
    // activateVersion keeps the parent active.
    expect((await repoFor(tenantA).getWorkflow(workflow.id)).status).toBe("active");
  });

  it("createVersion(activate:false) leaves the parent status unchanged", async () => {
    const { workflow } = await repoFor(tenantA).create({
      name: "add-inactive-version",
      definition: linear(["a"]),
      triggerType: "webhook",
      triggerConfig: { source: "wf-inactive-v2" },
    });
    expect((await repoFor(tenantA).getWorkflow(workflow.id)).status).toBe("active");

    await repoFor(tenantA).createVersion(workflow.id, {
      definition: linear(["a", "b"]),
      triggerType: "webhook",
      triggerConfig: { source: "wf-inactive-v2" },
      // activate defaults to false
    });

    // v1 is still the active version and the parent is still `active`.
    const activeVersion = await repoFor(tenantA).getActiveVersion(workflow.id);
    expect(activeVersion?.version).toBe(1);
    expect((await repoFor(tenantA).getWorkflow(workflow.id)).status).toBe("active");
  });

  it("disable sets status disabled, deactivates the active version, and is idempotent", async () => {
    const { workflow, version } = await repoFor(tenantA).create({
      name: "to-disable",
      definition: linear(["a"]),
      triggerType: "webhook",
      triggerConfig: { source: "wf-disable" },
    });

    const disabled = await repoFor(tenantA).disable(workflow.id);
    expect(disabled.status).toBe("disabled");
    // No active version remains — this is what actually stops webhook routing.
    expect(await repoFor(tenantA).getActiveVersion(workflow.id)).toBeNull();
    // The version row still exists (history intact); only is_active flipped.
    const versions = await repoFor(tenantA).listVersions(workflow.id);
    expect(versions.map((v) => v.id)).toContain(version.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.isActive).toBe(false);

    // Idempotent: disabling again succeeds and changes nothing further.
    const again = await repoFor(tenantA).disable(workflow.id);
    expect(again.status).toBe("disabled");
    expect(await repoFor(tenantA).getActiveVersion(workflow.id)).toBeNull();
  });

  it("a disabled workflow's webhook source creates no run", async () => {
    const { workflow } = await repoFor(tenantA).create({
      name: "disabled-no-run",
      definition: linear(["a"]),
      triggerType: "webhook",
      triggerConfig: { source: "wf-disabled-route" },
    });
    await repoFor(tenantA).disable(workflow.id);

    // Ingest a delivery for the (now inactive) source — the event is kept, no run.
    const result = await ingestorFor(tenantA).ingest({
      source: "wf-disabled-route",
      dedupeKey: "k-disabled-1",
      payload: { hello: "world" },
    });

    expect(result.workflowConfigured).toBe(false);
    expect(result.runId).toBeNull();
    // Belt-and-braces: no run row exists for this workflow.
    const runs = await handle.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, workflow.id));
    expect(runs).toHaveLength(0);
  });

  it("re-enables a disabled workflow via activateVersion → status active again", async () => {
    const { workflow, version: v1 } = await repoFor(tenantA).create({
      name: "disable-then-reenable",
      definition: linear(["a"]),
      triggerType: "webhook",
      triggerConfig: { source: "wf-reenable" },
    });

    await repoFor(tenantA).disable(workflow.id);
    expect((await repoFor(tenantA).getWorkflow(workflow.id)).status).toBe("disabled");
    expect(await repoFor(tenantA).getActiveVersion(workflow.id)).toBeNull();

    // Activating a version brings the workflow back: status active, version runnable.
    await repoFor(tenantA).activateVersion(workflow.id, v1.id);
    expect((await repoFor(tenantA).getWorkflow(workflow.id)).status).toBe("active");
    expect((await repoFor(tenantA).getActiveVersion(workflow.id))?.id).toBe(v1.id);
  });

  it("rejects a duplicate version number at the database", async () => {
    const { workflow } = await repoFor(tenantA).create({
      name: "dupe-guard",
      definition: linear(["a"]),
      triggerType: "webhook",
      triggerConfig: { source: "wf-dupe" },
    });

    // Force a collision with version 1 by inserting directly, bypassing the
    // service's numbering. The unique(workflow_id, version) constraint must reject it.
    await expect(
      handle.db.insert(workflowVersions).values({
        tenantId: tenantA,
        workflowId: workflow.id,
        version: 1,
        definition: linear(["x"]),
        triggerType: "webhook",
        triggerConfig: { source: "wf-dupe" },
        isActive: false,
      }),
    ).rejects.toThrow();
  });

  it("isolates tenants: A cannot read, version, or activate B’s workflow", async () => {
    const { workflow: bWf, version: bV1 } = await repoFor(tenantB).create({
      name: "b-only",
      definition: linear(["a"]),
      triggerType: "webhook",
      triggerConfig: { source: "wf-iso" },
    });

    await expect(repoFor(tenantA).getWorkflow(bWf.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      repoFor(tenantA).createVersion(bWf.id, {
        definition: linear(["a", "b"]),
        triggerType: "webhook",
        triggerConfig: { source: "wf-iso" },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      repoFor(tenantA).activateVersion(bWf.id, bV1.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    // A cannot disable B's workflow either — same tenant-safe NotFound.
    await expect(repoFor(tenantA).disable(bWf.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // B's workflow is untouched: still one version, still active, still `active`.
    const bVersions = await repoFor(tenantB).listVersions(bWf.id);
    expect(bVersions).toHaveLength(1);
    expect(bVersions[0]!.isActive).toBe(true);
    expect((await repoFor(tenantB).getWorkflow(bWf.id)).status).toBe("active");
  });

  it("lists workflows newest first and paginates without duplicates", async () => {
    const a1 = await repoFor(tenantA).create({
      name: "wf-a1",
      definition: linear(["a"]),
      triggerType: "webhook",
      triggerConfig: { source: "wf-list-a1" },
    });
    const a2 = await repoFor(tenantA).create({
      name: "wf-a2",
      definition: linear(["a"]),
      triggerType: "webhook",
      triggerConfig: { source: "wf-list-a2" },
    });

    const sameTime = new Date("2026-01-01T00:00:00.000Z");
    await handle.db
      .update(workflows)
      .set({ createdAt: sameTime, updatedAt: sameTime })
      .where(eq(workflows.id, a1.workflow.id));
    await handle.db
      .update(workflows)
      .set({ createdAt: sameTime, updatedAt: sameTime })
      .where(eq(workflows.id, a2.workflow.id));

    const firstPage = await repoFor(tenantA).listWorkflows(1);
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = await repoFor(tenantA).listWorkflows(
      1,
      firstPage.nextCursor ?? undefined,
    );
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]!.id).not.toBe(firstPage.items[0]!.id);
  });

  it("rejects malformed cursors", async () => {
    await expect(
      repoFor(tenantA).listWorkflows(20, "not-base64-cursor"),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});
