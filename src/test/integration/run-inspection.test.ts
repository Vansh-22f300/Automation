/**
 * Integration tests for run inspection — require a real PostgreSQL and are
 * SKIPPED (never faked) unless `TEST_DATABASE_URL` is set.
 *
 *   TEST_DATABASE_URL=postgresql://…/ai_workforce_test pnpm test
 *
 * What these prove against genuine rows, foreign keys and tenant-scoped queries,
 * which the pure assembler tests cannot:
 *
 *   - a run assembles into one coherent view (run + workflow + version + event +
 *     steps + jobs + usage), all fetched under the tenant predicate;
 *   - step runs come back in execution order and llm usage is attributed to the
 *     right step key, with tool activity reconstructed from round counts;
 *   - values are summarized (and secret-scrubbed) by default; `--detail` attaches
 *     the scrubbed raw values;
 *   - a run of another tenant, or a nonexistent run, both return null (the API's
 *     identical 404);
 *   - `leased` reflects a live lease held on a running job.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BadRequestError } from "@/api/errors.js";
import {
  events,
  jobs,
  llmUsage,
  tenants,
  workflowRuns,
  workflowStepRuns,
} from "@/db/schema.js";
import { RunInspectionRepository } from "@/repositories/run-inspection-repository.js";
import { PostgresJobQueue } from "@/repositories/job-queue.js";
import { TenantScope } from "@/repositories/tenant-scope.js";
import { WebhookRepository } from "@/repositories/webhook-repository.js";
import { WorkflowRepository } from "@/repositories/workflow-repository.js";
import type { DatabaseHandle } from "@/db/client.js";

import { TEST_DATABASE_URL, createTestDatabaseHandle } from "./support.js";

const definition = (...keys: string[]) => ({
  version: 1,
  steps: keys.map((key) => ({ key, type: "noop", config: {} })),
});

describe.skipIf(TEST_DATABASE_URL === undefined)(
  "run inspection integration",
  () => {
    let handle: DatabaseHandle;
    let tenantA: string;
    let tenantB: string;

    beforeAll(async () => {
      handle = createTestDatabaseHandle();
      await handle.verifyConnection();
      const inserted = await handle.db
        .insert(tenants)
        .values([{ name: "Inspect Tenant A" }, { name: "Inspect Tenant B" }])
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

    beforeEach(async () => {
      await handle.db.delete(llmUsage);
      await handle.db.delete(workflowStepRuns);
      await handle.db.delete(jobs);
      await handle.db.delete(workflowRuns);
      await handle.db.delete(events);
    });

    /** Author an active workflow and ingest one event → a queued run + first job. */
    const seedRun = async (
      tenantId: string,
      source: string,
      ...stepKeys: string[]
    ): Promise<string> => {
      const workflows = new WorkflowRepository(
        new TenantScope(handle.db, tenantId),
      );
      await workflows.create({
        name: `wf-${source}`,
        definition: definition(...stepKeys),
        triggerType: "webhook",
        triggerConfig: { source },
      });
      const ingestor = new WebhookRepository(
        new TenantScope(handle.db, tenantId),
        new PostgresJobQueue(handle.db),
      );
      const result = await ingestor.ingest({
        source,
        dedupeKey: `seed-${source}`,
        payload: { hello: "world" },
      });
      return result.runId as string;
    };

    const repo = (tenantId: string, now?: () => Date) =>
      new RunInspectionRepository(new TenantScope(handle.db, tenantId), now);

    it("assembles a coherent view of an own run", async () => {
      const runId = await seedRun(tenantA, "coherent", "a");
      const view = await repo(tenantA).getRun(runId);
      expect(view).not.toBeNull();
      expect(view!.run.id).toBe(runId);
      expect(view!.workflow.name).toBe("wf-coherent");
      expect(view!.version.version).toBe(1);
      expect(view!.event.source).toBe("coherent");
      expect(view!.jobs.length).toBeGreaterThanOrEqual(1);
      expect(view!.jobs[0]!.stepKey).toBe("a");
    });

    it("orders step runs by start time and attributes llm usage + tools", async () => {
      const runId = await seedRun(tenantA, "ordered", "a", "b");
      const [srA] = await handle.db
        .insert(workflowStepRuns)
        .values({
          tenantId: tenantA,
          runId,
          stepKey: "a",
          stepType: "llm",
          status: "succeeded",
          output: { answer: 42 },
          startedAt: new Date(1_000),
          finishedAt: new Date(1_050),
          durationMs: 50,
        })
        .returning({ id: workflowStepRuns.id });
      const [srB] = await handle.db
        .insert(workflowStepRuns)
        .values({
          tenantId: tenantA,
          runId,
          stepKey: "b",
          stepType: "llm",
          status: "succeeded",
          output: { answer: 7 },
          startedAt: new Date(2_000),
          finishedAt: new Date(2_100),
          durationMs: 100,
        })
        .returning({ id: workflowStepRuns.id });

      // Step a: one round (no tools). Step b: two rounds (tools used).
      await handle.db.insert(llmUsage).values([
        {
          tenantId: tenantA,
          runId,
          stepRunId: srA!.id,
          provider: "claude",
          model: "m",
          round: 1,
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          latencyMs: 10,
        },
        {
          tenantId: tenantA,
          runId,
          stepRunId: srB!.id,
          provider: "claude",
          model: "m",
          round: 1,
          inputTokens: 4,
          outputTokens: 5,
          totalTokens: 9,
          latencyMs: 20,
        },
        {
          tenantId: tenantA,
          runId,
          stepRunId: srB!.id,
          provider: "claude",
          model: "m",
          round: 2,
          inputTokens: 6,
          outputTokens: 7,
          totalTokens: 13,
          latencyMs: 30,
        },
      ]);

      const view = await repo(tenantA).getRun(runId);
      expect(view!.steps.map((s) => s.stepKey)).toEqual(["a", "b"]);
      expect(view!.llmUsage.map((u) => [u.stepKey, u.round])).toEqual([
        ["a", 1],
        ["b", 1],
        ["b", 2],
      ]);
      expect(view!.tools).toEqual([
        { stepKey: "a", rounds: 1, usedTools: false, toolRounds: 0 },
        { stepKey: "b", rounds: 2, usedTools: true, toolRounds: 1 },
      ]);
      expect(view!.usageTotals.totalTokens).toBe(25);
    });

    it("summarizes and scrubs by default, and attaches scrubbed raw values in detail mode", async () => {
      const runId = await seedRun(tenantA, "secrets", "a");
      await handle.db.insert(workflowStepRuns).values({
        tenantId: tenantA,
        runId,
        stepKey: "a",
        stepType: "noop",
        status: "succeeded",
        output: { token: "top-secret-value" },
        startedAt: new Date(1_000),
        finishedAt: new Date(1_010),
        durationMs: 10,
      });

      const summary = await repo(tenantA).getRun(runId);
      expect(summary!.steps[0]!.output).toBeUndefined();
      expect(summary!.steps[0]!.outputSummary.preview).toContain(
        "«redacted:secret-key»",
      );
      expect(summary!.steps[0]!.outputSummary.preview).not.toContain(
        "top-secret-value",
      );

      const detailed = await repo(tenantA).getRun(runId, { detail: true });
      expect(JSON.stringify(detailed!.steps[0]!.output)).toContain(
        "«redacted:secret-key»",
      );
      expect(JSON.stringify(detailed!.steps[0]!.output)).not.toContain(
        "top-secret-value",
      );
    });

    it("returns null for another tenant’s run and for a nonexistent run", async () => {
      const runId = await seedRun(tenantA, "isolated", "a");
      expect(await repo(tenantB).getRun(runId)).toBeNull();
      expect(
        await repo(tenantA).getRun("00000000-0000-0000-0000-000000000000"),
      ).toBeNull();
    });

    it("reports leased=true for a running job under a live lease", async () => {
      const runId = await seedRun(tenantA, "leased", "a");
      await handle.db
        .update(jobs)
        .set({
          status: "running",
          lockedBy: "worker-1",
          leaseExpiresAt: new Date(Date.now() + 60_000),
        })
        .where(eq(jobs.runId, runId));

      const view = await repo(tenantA, () => new Date()).getRun(runId);
      expect(view!.jobs[0]!.leased).toBe(true);
      // The worker id is never surfaced.
      expect(JSON.stringify(view)).not.toContain("worker-1");
    });

    it("lists runs newest first, filters safely, and paginates without duplicates", async () => {
      const runA = await seedRun(tenantA, "list-a", "a");
      const runB = await seedRun(tenantA, "list-b", "a");

      const sameTime = new Date("2026-01-02T00:00:00.000Z");
      await handle.db
        .update(workflowRuns)
        .set({ createdAt: sameTime, startedAt: sameTime })
        .where(eq(workflowRuns.id, runA));
      await handle.db
        .update(workflowRuns)
        .set({ createdAt: sameTime, startedAt: sameTime })
        .where(eq(workflowRuns.id, runB));

      const firstPage = await repo(tenantA).listRuns({ limit: 1 });
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.nextCursor).toBeTruthy();

      const secondPage = await repo(tenantA).listRuns(
        firstPage.nextCursor === null
          ? { limit: 1 }
          : { limit: 1, cursor: firstPage.nextCursor },
      );
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.items[0]!.id).not.toBe(firstPage.items[0]!.id);

      const filtered = await repo(tenantA).listRuns({
        status: "queued",
        workflowId: firstPage.items[0]!.workflowId,
      });
      expect(filtered.items.every((item) => item.status === "queued")).toBe(
        true,
      );
      expect(JSON.stringify(filtered.items)).not.toContain("trigger");
    });

    it("rejects malformed cursors", async () => {
      await expect(
        repo(tenantA).listRuns({ cursor: "not-base64-cursor" }),
      ).rejects.toBeInstanceOf(BadRequestError);
    });
  },
);
