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
 *   - `leased` reflects a live lease held on a running job;
 *   - durable tool-effect rows (the authoritative actual-tool-call record) surface
 *     on BOTH the summary and detail surfaces, projected to safe fields only, and
 *     are unreachable across tenants.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { BadRequestError } from "@/api/errors.js";
import {
  events,
  jobs,
  llmUsage,
  tenants,
  toolEffects,
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
      await handle.db.delete(toolEffects);
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

    /** Insert one durable effect-ledger row for a run (sensible read-tool defaults). */
    const seedEffect = async (
      tenantId: string,
      runId: string,
      over: Partial<typeof toolEffects.$inferInsert> = {},
    ): Promise<void> => {
      const stepKey = over.stepKey ?? "whoami";
      const toolName = over.toolName ?? "github_get_authenticated_user";
      const ordinal = over.ordinal ?? 1;
      await handle.db.insert(toolEffects).values({
        tenantId,
        runId,
        stepKey,
        toolName,
        ordinal,
        idempotencyKey: `${runId}:${stepKey}:${toolName}:${ordinal}`,
        provider: over.provider ?? "github",
        state: over.state ?? "succeeded",
        owner: over.owner ?? null,
        leaseExpiresAt: over.leaseExpiresAt ?? null,
        result: over.result ?? null,
        error: over.error ?? null,
      });
    };

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

    it("surfaces a succeeded external effect on the SUMMARY surface (default, no --detail)", async () => {
      const runId = await seedRun(tenantA, "effect-success", "whoami");
      await seedEffect(tenantA, runId, {
        toolName: "github_get_authenticated_user",
        provider: "github",
        ordinal: 1,
        state: "succeeded",
        result: { login: "octocat", id: 583231 },
      });

      const summary = await repo(tenantA).getRun(runId);
      expect(summary!.toolEffects).toEqual([
        {
          stepKey: "whoami",
          toolName: "github_get_authenticated_user",
          ordinal: 1,
          provider: "github",
          state: "succeeded",
          ambiguous: false,
          error: null,
        },
      ]);
      // The stored raw result is never projected, on either surface.
      expect(JSON.stringify(summary!.toolEffects)).not.toContain("583231");
      // Effects are mode-independent — identical on the detail surface.
      const detailed = await repo(tenantA).getRun(runId, { detail: true });
      expect(detailed!.toolEffects).toEqual(summary!.toolEffects);
    });

    it("surfaces a failed external effect with a sanitized {code, message} error", async () => {
      const runId = await seedRun(tenantA, "effect-failed", "whoami");
      await seedEffect(tenantA, runId, {
        state: "failed",
        error: {
          code: "http_500",
          message: "bad gateway",
          details: { trace: "secret-trace-xyz" },
        },
      });

      const summary = await repo(tenantA).getRun(runId);
      expect(summary!.toolEffects).toHaveLength(1);
      const effect = summary!.toolEffects[0]!;
      expect(effect.state).toBe("failed");
      expect(effect.ambiguous).toBe(false);
      // toSafeError keeps {code, message}, drops the details payload.
      expect(effect.error).toEqual({ code: "http_500", message: "bad gateway" });
      expect(JSON.stringify(summary!.toolEffects)).not.toContain("secret-trace-xyz");
    });

    it("surfaces an ambiguous effect on the summary surface — state/tool/ordinal present, secrets absent", async () => {
      const runId = await seedRun(tenantA, "effect-ambiguous", "whoami");
      // A crash left this Slack send with an unknown outcome: the ledger settled it
      // `ambiguous` (deliberately not auto-resent). The row carries fields that MUST
      // NOT surface — the idempotency key, the owner token, the stored result, and an
      // error whose details hold a bot token.
      const OWNER = "11111111-1111-4111-8111-111111111111";
      await seedEffect(tenantA, runId, {
        toolName: "send_slack_message",
        provider: "slack",
        ordinal: 1,
        state: "ambiguous",
        owner: OWNER,
        result: { channel: "C123", ts: "1700000000.000100" },
        error: {
          code: "effect_ambiguous",
          message: "worker crashed after dispatch, before settlement",
          details: { botToken: "xoxb-super-secret", channel: "C-private" },
        },
      });

      // Present on the SUMMARY surface now (no --detail), with exactly the safe fields.
      const summary = await repo(tenantA).getRun(runId);
      expect(summary!.toolEffects).toHaveLength(1);
      const effect = summary!.toolEffects[0]!;
      expect(effect.state).toBe("ambiguous");
      expect(effect.ambiguous).toBe(true);
      expect(effect.toolName).toBe("send_slack_message");
      expect(effect.ordinal).toBe(1);
      expect(effect.provider).toBe("slack");
      expect(effect.error).toEqual({
        code: "effect_ambiguous",
        message: "worker crashed after dispatch, before settlement",
      });
      // Identical on the detail surface.
      const detailed = await repo(tenantA).getRun(runId, { detail: true });
      expect(detailed!.toolEffects).toEqual(summary!.toolEffects);

      // Nothing sensitive crosses the boundary.
      const serialized = JSON.stringify(summary!.toolEffects);
      expect(serialized).not.toContain("xoxb-super-secret"); // secret in error.details
      expect(serialized).not.toContain("C-private"); // error.details
      expect(serialized).not.toContain("1700000000.000100"); // stored result ts
      expect(serialized).not.toContain(OWNER); // owner token
      expect(serialized).not.toContain(
        `${runId}:whoami:send_slack_message:1`,
      ); // idempotency key
    });

    it("orders repeated durable calls to the same tool by ordinal (actual per-call record)", async () => {
      const runId = await seedRun(tenantA, "effect-repeated", "whoami");
      // Two distinct calls to the same tool in one step — distinguished by ordinal,
      // which the INFERRED tool-activity count cannot do.
      await seedEffect(tenantA, runId, { ordinal: 2, state: "succeeded" });
      await seedEffect(tenantA, runId, { ordinal: 1, state: "succeeded" });

      const summary = await repo(tenantA).getRun(runId);
      expect(summary!.toolEffects.map((e) => e.ordinal)).toEqual([1, 2]);
      expect(
        summary!.toolEffects.every(
          (e) => e.toolName === "github_get_authenticated_user",
        ),
      ).toBe(true);
    });

    it("returns an empty toolEffects array for a run with no ledgered tool call", async () => {
      const runId = await seedRun(tenantA, "effect-empty", "a");
      const summary = await repo(tenantA).getRun(runId);
      expect(summary!.toolEffects).toEqual([]);
    });

    it("never surfaces another tenant's effects (foreign-tenant isolation)", async () => {
      const runId = await seedRun(tenantA, "effect-isolated", "whoami");
      await seedEffect(tenantA, runId, { ordinal: 1, state: "succeeded" });
      // Tenant A sees its own effect.
      expect((await repo(tenantA).getRun(runId))!.toolEffects).toHaveLength(1);
      // Tenant B cannot resolve the run at all — the same null as a nonexistent run —
      // so A's effect rows are unreachable to B.
      expect(await repo(tenantB).getRun(runId)).toBeNull();
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
