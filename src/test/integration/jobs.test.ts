/**
 * Integration tests for the PostgreSQL job queue — these require a real Postgres.
 *
 * SKIPPED unless `TEST_DATABASE_URL` is set; never faked. The whole point of the
 * queue is behaviour that only a real server exhibits — `FOR UPDATE SKIP LOCKED`
 * under genuine concurrency, transactional claims, partial-index-backed lease
 * reaping — so mocking it would prove nothing. If the variable is absent the
 * suite reports skipped, not passed.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_workforce_test pnpm test
 *
 * What these prove that the offline unit tests cannot:
 *   - claim moves exactly one pending row to running under a lease, oldest first;
 *   - a future run_at is not claimed; an empty queue yields null;
 *   - two workers claiming concurrently never receive the same job, and each
 *     gets a distinct job when several are ready (the SKIP LOCKED guarantee);
 *   - complete/fail only act on a running job, and only for the worker that still
 *     holds its lease; illegal transitions are rejected;
 *   - a done/failed job is terminal and never re-claimed;
 *   - a graceful-shutdown release returns an owned running job to pending without
 *     touching attempt, retry_count, last_error or run_at — and an old worker
 *     cannot release a lease another worker has since claimed;
 *   - the reaper returns expired-lease running jobs to pending, increments the
 *     attempt, clears the lock, and leaves live leases alone;
 *   - a job that has burned its crash-recovery budget is dead-lettered instead of
 *     being requeued forever, without touching its business retry counter;
 *   - a tenant-scoped queue can neither claim nor mutate another tenant's jobs.
 *
 * The suite writes and deletes rows, so it refuses any database whose name does
 * not contain "test", and wipes the jobs table between tests for isolation.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseHandle } from "@/db/client.js";
import { jobs, tenants } from "@/db/schema.js";
import { InvalidJobTransitionError, MAX_CRASH_ATTEMPTS } from "@/domain/queue.js";
import { DEFAULT_LEASE_MS } from "@/domain/timing.js";
import { PostgresJobQueue } from "@/repositories/job-queue.js";
import { TenantScope } from "@/repositories/tenant-scope.js";
import { WebhookRepository } from "@/repositories/webhook-repository.js";
import { WorkflowRepository } from "@/repositories/workflow-repository.js";

import { TEST_DATABASE_URL, createTestDatabaseHandle } from "./support.js";

const definition = () => ({
  version: 1,
  steps: [
    { key: "first", type: "noop", config: {} },
    { key: "second", type: "noop", config: {} },
  ],
});

describe.skipIf(TEST_DATABASE_URL === undefined)(
  "postgres job queue integration",
  () => {
    let handle: DatabaseHandle;
    let tenantA: string;
    let tenantB: string;
    let runA: string;
    let runB: string;

    const queueFor = (tenantId?: string): PostgresJobQueue =>
      new PostgresJobQueue(
        handle.db,
        tenantId === undefined ? {} : { tenantId },
      );

    const jobById = async (id: string) => {
      const [row] = await handle.db.select().from(jobs).where(eq(jobs.id, id));
      return row;
    };

    /**
     * Force a claimed job's lease into the past — and optionally put its crash
     * counter at a chosen value.
     *
     * Deterministic on purpose: lease expiry is a timestamp comparison, so it can
     * be *stated* rather than waited for. A short `leaseDurationMs` plus a sleep
     * would test the test runner's timing, not the queue, and would be the first
     * thing to flake on a loaded CI runner.
     */
    const expireLease = async (id: string, attempt?: number): Promise<void> => {
      await handle.db
        .update(jobs)
        .set({
          leaseExpiresAt: new Date(Date.now() - 1),
          ...(attempt === undefined ? {} : { attempt }),
        })
        .where(eq(jobs.id, id));
    };

    const seedRun = async (
      tenantId: string,
      source: string,
    ): Promise<string> => {
      const workflows = new WorkflowRepository(
        new TenantScope(handle.db, tenantId),
      );
      await workflows.create({
        name: `wf-${source}`,
        definition: definition(),
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
        payload: {},
      });
      return result.runId as string;
    };

    beforeAll(async () => {
      handle = createTestDatabaseHandle();
      await handle.verifyConnection();

      const inserted = await handle.db
        .insert(tenants)
        .values([{ name: "Queue Tenant A" }, { name: "Queue Tenant B" }])
        .returning({ id: tenants.id });
      tenantA = inserted[0]!.id;
      tenantB = inserted[1]!.id;

      runA = await seedRun(tenantA, "queue-a");
      runB = await seedRun(tenantB, "queue-b");
    });

    afterAll(async () => {
      if (handle === undefined) return;
      for (const id of [tenantA, tenantB]) {
        if (id !== undefined)
          await handle.db.delete(tenants).where(eq(tenants.id, id));
      }
      await handle.close();
    });

    // A clean queue per test. Runs (and their tenants) persist; only jobs reset.
    beforeEach(async () => {
      await handle.db.delete(jobs);
    });

    describe("enqueue", () => {
      it("creates a pending job with sensible defaults and no lease", async () => {
        const { id } = await queueFor().enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        const job = await jobById(id);

        expect(job).toBeDefined();
        expect(job!.status).toBe("pending");
        expect(job!.attempt).toBe(0);
        expect(job!.retryCount).toBe(0);
        expect(job!.maxAttempts).toBe(5);
        expect(job!.lockedBy).toBeNull();
        expect(job!.leaseExpiresAt).toBeNull();
        expect(job!.runAt).toBeInstanceOf(Date);
      });

      it("rejects a job whose (tenant, run) pair does not exist (composite FK)", async () => {
        await expect(
          queueFor().enqueue({
            tenantId: tenantB,
            runId: runA,
            stepKey: "first",
          }),
        ).rejects.toThrow();
      });
    });

    describe("claim", () => {
      it("stamps the centrally derived lease on the row it claims", async () => {
        // The arithmetic invariant (lease > worst-case step duration) is proven in
        // src/test/unit/timing.test.ts, which runs without a database. What only a
        // real server can show is that the queue actually stamps *that* lease.
        const { id } = await queueFor().enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });

        const before = Date.now();
        const claimed = await queueFor().claim("worker-1");
        const stamped = claimed!.leaseExpiresAt.getTime();

        expect(stamped).toBeGreaterThanOrEqual(before + DEFAULT_LEASE_MS);
        expect(stamped).toBeLessThanOrEqual(Date.now() + DEFAULT_LEASE_MS);
        expect((await jobById(id))!.leaseExpiresAt!.getTime()).toBe(stamped);
      });

      it("moves the oldest pending job to running under a lease", async () => {
        const { id } = await queueFor().enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });

        const claimed = await queueFor().claim("worker-1");
        expect(claimed).not.toBeNull();
        expect(claimed!.id).toBe(id);
        expect(claimed!.lockedBy).toBe("worker-1");
        expect(claimed!.leaseExpiresAt).toBeInstanceOf(Date);

        const job = await jobById(id);
        expect(job!.status).toBe("running");
        expect(job!.lockedBy).toBe("worker-1");
        expect(job!.leaseExpiresAt).toBeInstanceOf(Date);
      });

      it("returns null when nothing is ready", async () => {
        await expect(queueFor().claim("worker-1")).resolves.toBeNull();
      });

      it("does not claim a job whose run_at is in the future", async () => {
        const future = new Date(Date.now() + 60_000);
        await queueFor().enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
          runAt: future,
        });

        await expect(queueFor().claim("worker-1")).resolves.toBeNull();
      });

      it("does not re-claim a job that is already running", async () => {
        await queueFor().enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        await queueFor().claim("worker-1");

        await expect(queueFor().claim("worker-2")).resolves.toBeNull();
      });
    });

    describe("concurrency (SKIP LOCKED)", () => {
      it("never hands the same job to two workers claiming at once", async () => {
        await queueFor().enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });

        const [a, b] = await Promise.all([
          queueFor().claim("w1"),
          queueFor().claim("w2"),
        ]);
        const claimed = [a, b].filter((c) => c !== null);

        expect(claimed).toHaveLength(1);
      });

      it("gives concurrent workers distinct jobs when several are ready", async () => {
        const q = queueFor();
        await q.enqueue({ tenantId: tenantA, runId: runA, stepKey: "first" });
        await q.enqueue({ tenantId: tenantA, runId: runA, stepKey: "second" });

        const [a, b] = await Promise.all([
          queueFor().claim("w1"),
          queueFor().claim("w2"),
        ]);

        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        expect(a!.id).not.toBe(b!.id);
      });
    });

    describe("complete / fail transitions", () => {
      it("completes a running job and forbids completing anything else", async () => {
        const q = queueFor();
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });

        // pending → complete is illegal (never claimed).
        await expect(q.complete(id, "worker-1")).rejects.toBeInstanceOf(
          InvalidJobTransitionError,
        );

        await q.claim("worker-1");
        await q.complete(id, "worker-1");
        expect((await jobById(id))!.status).toBe("done");

        // done → complete again is illegal; the job is terminal.
        await expect(q.complete(id, "worker-1")).rejects.toBeInstanceOf(
          InvalidJobTransitionError,
        );
      });

      it("fails a running job with a structured error and clears its lease", async () => {
        const q = queueFor();
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        await q.claim("worker-1");

        await q.fail(id, "worker-1", { code: "boom", message: "nope" });
        const job = await jobById(id);
        expect(job!.status).toBe("failed");
        expect(job!.lastError).toEqual({ code: "boom", message: "nope" });
        expect(job!.lockedBy).toBeNull();
        expect(job!.leaseExpiresAt).toBeNull();

        // failed → running is not automatic, and failed cannot be failed again.
        await expect(q.fail(id, "worker-1", { code: "again" })).rejects.toBeInstanceOf(
          InvalidJobTransitionError,
        );
      });

      it("does not let a different worker settle a running job it does not own", async () => {
        const q = queueFor();
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        await q.claim("worker-1");

        await expect(q.complete(id, "worker-2")).rejects.toBeInstanceOf(
          InvalidJobTransitionError,
        );
        await expect(q.fail(id, "worker-2", { code: "x" })).rejects.toBeInstanceOf(
          InvalidJobTransitionError,
        );
        await expect(
          q.retry(id, "worker-2", { code: "x" }, new Date(Date.now() + 1_000)),
        ).rejects.toBeInstanceOf(InvalidJobTransitionError);

        const job = await jobById(id);
        expect(job!.status).toBe("running");
        expect(job!.lockedBy).toBe("worker-1");
      });

      it("never re-claims a terminal job", async () => {
        const q = queueFor();
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        await q.claim("worker-1");
        await q.complete(id, "worker-1");

        await expect(queueFor().claim("worker-2")).resolves.toBeNull();
      });
    });

    describe("reaper (requeueExpired)", () => {
      it("returns an expired-lease job to pending, incrementing its attempt", async () => {
        const q = queueFor();
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        await q.claim("worker-dead");
        await expireLease(id);

        const result = await queueFor().requeueExpired();
        expect(result.requeued).toBe(1);
        expect(result.deadLettered).toEqual([]);

        const job = await jobById(id);
        expect(job!.status).toBe("pending");
        expect(job!.attempt).toBe(1);
        // Crash recovery must NOT consume the business retry budget.
        expect(job!.retryCount).toBe(0);
        expect(job!.lockedBy).toBeNull();
        expect(job!.leaseExpiresAt).toBeNull();
      });

      it("leaves a job with a live lease alone", async () => {
        const q = queueFor(); // default centrally-derived safe lease
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        await q.claim("worker-1");

        await expect(q.requeueExpired()).resolves.toEqual({
          requeued: 0,
          deadLettered: [],
        });
        expect((await jobById(id))!.status).toBe("running");
      });
    });

    describe("reaper poison-job ceiling (dead-letter)", () => {
      it("dead-letters an expired job whose crash-recovery budget is exhausted", async () => {
        const q = queueFor();
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        await q.claim("worker-that-keeps-dying");
        await expireLease(id, MAX_CRASH_ATTEMPTS);

        const result = await queueFor().requeueExpired();
        expect(result.requeued).toBe(0);
        expect(result.deadLettered).toEqual([
          {
            id,
            tenantId: tenantA,
            runId: runA,
            stepKey: "first",
            attempt: MAX_CRASH_ATTEMPTS,
          },
        ]);

        const job = await jobById(id);
        expect(job!.status).toBe("failed");
        // No recovery happened, so no attempt is consumed: `attempt === the
        // ceiling` remains the readable "exhausted" signal.
        expect(job!.attempt).toBe(MAX_CRASH_ATTEMPTS);
        expect(job!.retryCount).toBe(0);
        expect(job!.lockedBy).toBeNull();
        expect(job!.leaseExpiresAt).toBeNull();
        expect(job!.lastError!.code).toBe("crash_attempts_exhausted");
        expect(job!.lastError!.retryable).toBe(false);
        expect(job!.lastError!.details).toEqual({
          crash_attempt_limit: MAX_CRASH_ATTEMPTS,
        });
        expect(typeof job!.lastError!.message).toBe("string");
      });

      it("recovers the job on its last remaining attempt, and condemns it on the next expiry", async () => {
        const q = queueFor();
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        await q.claim("worker-dead-1");

        // One attempt short of the ceiling: still recoverable.
        await expireLease(id, MAX_CRASH_ATTEMPTS - 1);
        const first = await queueFor().requeueExpired();
        expect(first.requeued).toBe(1);
        expect(first.deadLettered).toEqual([]);
        expect((await jobById(id))!.status).toBe("pending");
        expect((await jobById(id))!.attempt).toBe(MAX_CRASH_ATTEMPTS);

        // It is claimed again, and abandoned again. Now the budget is spent.
        await q.claim("worker-dead-2");
        await expireLease(id);
        const second = await queueFor().requeueExpired();
        expect(second.requeued).toBe(0);
        expect(second.deadLettered.map((j) => j.id)).toEqual([id]);
        expect((await jobById(id))!.status).toBe("failed");
      });

      it("a dead-lettered job is terminal: no later sweep requeues it and no worker claims it", async () => {
        const q = queueFor();
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        await q.claim("worker-dead");
        await expireLease(id, MAX_CRASH_ATTEMPTS);
        expect((await queueFor().requeueExpired()).deadLettered).toHaveLength(1);

        // The job is no longer `running`, so every subsequent sweep skips it —
        // it can never be dead-lettered twice or returned to pending.
        await expect(queueFor().requeueExpired()).resolves.toEqual({
          requeued: 0,
          deadLettered: [],
        });
        expect((await jobById(id))!.status).toBe("failed");
        await expect(queueFor().claim("worker-2")).resolves.toBeNull();
      });

      it("keeps the crash counter and the business retry counter independent", async () => {
        const q = queueFor();
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });

        // A business retry first: retry_count moves, attempt does not.
        await q.claim("worker-1");
        await q.retry(
          id,
          "worker-1",
          { code: "llm_rate_limited", retryable: true },
          new Date(Date.now() - 1_000), // immediately claimable again
        );
        expect((await jobById(id))!.retryCount).toBe(1);
        expect((await jobById(id))!.attempt).toBe(0);

        // Then a crash at the ceiling: attempt decides the dead-letter, and the
        // business counter is left exactly as the retry left it.
        await q.claim("worker-2");
        await expireLease(id, MAX_CRASH_ATTEMPTS);
        expect((await queueFor().requeueExpired()).deadLettered).toHaveLength(1);

        const job = await jobById(id);
        expect(job!.status).toBe("failed");
        expect(job!.retryCount).toBe(1);
        expect(job!.attempt).toBe(MAX_CRASH_ATTEMPTS);
        expect(job!.maxAttempts).toBe(5); // the business budget is untouched
      });

      it("requeues and dead-letters in the same sweep, each by its own budget", async () => {
        const q = queueFor();
        const healthy = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        const poison = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "second",
        });
        await q.claim("worker-1");
        await q.claim("worker-2");

        await expireLease(healthy.id, 0);
        await expireLease(poison.id, MAX_CRASH_ATTEMPTS);

        const result = await queueFor().requeueExpired();
        expect(result.requeued).toBe(1);
        expect(result.deadLettered.map((j) => j.id)).toEqual([poison.id]);

        expect((await jobById(healthy.id))!.status).toBe("pending");
        expect((await jobById(healthy.id))!.attempt).toBe(1);
        expect((await jobById(healthy.id))!.lastError).toBeNull();
        expect((await jobById(poison.id))!.status).toBe("failed");
      });
    });

    describe("release (graceful shutdown)", () => {
      it("releases an owned running job back to pending without consuming attempt or retry budget", async () => {
        const q = queueFor();
        // A distinctive past `run_at`: claimable now (claim requires `run_at <= now`),
        // and a value the release must leave exactly as it found it. A release is not
        // a deferral — the job becomes ready again immediately.
        const runAt = new Date(Date.now() - 60_000);
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
          runAt,
        });
        expect(await q.claim("worker-1")).not.toBeNull();
        // A job that has already burned a business retry, to prove the release does
        // not touch that counter either.
        await handle.db
          .update(jobs)
          .set({ retryCount: 2 })
          .where(eq(jobs.id, id));

        await expect(q.release(id, "worker-1")).resolves.toEqual({ outcome: "released" });

        const job = await jobById(id);
        expect(job!.status).toBe("pending");
        expect(job!.attempt).toBe(0);
        expect(job!.retryCount).toBe(2);
        expect(job!.runAt.getTime()).toBe(runAt.getTime());
        expect(job!.lastError).toBeNull();
        expect(job!.lockedBy).toBeNull();
        expect(job!.leaseExpiresAt).toBeNull();

        // The operational point of a voluntary release: the job is ready again at
        // once, not after the remainder of the lease the old worker walked away from.
        // (`beforeEach` empties `jobs`, so this is the only candidate.)
        const reclaimed = await q.claim("worker-2");
        expect(reclaimed!.id).toBe(id);
        expect(reclaimed!.attempt).toBe(0);
        expect(reclaimed!.retryCount).toBe(2);
      });

      it("is safe and idempotent when the job is no longer running", async () => {
        const q = queueFor();
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        await q.claim("worker-1");
        await q.complete(id, "worker-1");

        await expect(q.release(id, "worker-1")).resolves.toEqual({ outcome: "not_running", status: "done" });
        expect((await jobById(id))!.status).toBe("done");
      });

      it("does not let an old worker release a lease that a new worker has already claimed", async () => {
        const q = queueFor();
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        await q.claim("worker-old");
        await expireLease(id);

        expect((await q.requeueExpired()).requeued).toBe(1);
        const reclaimed = await q.claim("worker-new");
        expect(reclaimed).not.toBeNull();

        await expect(q.release(id, "worker-old")).resolves.toEqual({
          outcome: "not_owned",
          lockedBy: "worker-new",
        });

        const job = await jobById(id);
        expect(job!.status).toBe("running");
        expect(job!.lockedBy).toBe("worker-new");
        expect(job!.attempt).toBe(1);
        expect(job!.retryCount).toBe(0);
      });
    });

    describe("retry (business retries)", () => {
      it("moves a running job back to pending with a future run_at, bumping retry_count and not attempt", async () => {
        const q = queueFor();
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        await q.claim("worker-1");

        const runAt = new Date(Date.now() + 60_000);
        await q.retry(
          id,
          "worker-1",
          { code: "llm_rate_limited", message: "slow down", retryable: true },
          runAt,
        );

        const job = await jobById(id);
        expect(job!.status).toBe("pending");
        expect(job!.retryCount).toBe(1);
        expect(job!.attempt).toBe(0); // business retry never touches crash-recovery count
        expect(job!.lastError).toEqual({
          code: "llm_rate_limited",
          message: "slow down",
          retryable: true,
        });
        expect(job!.lockedBy).toBeNull();
        expect(job!.leaseExpiresAt).toBeNull();
        expect(job!.runAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
      });

      it("defers the retried job until its run_at, then makes it claimable", async () => {
        const q = queueFor();
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        await q.claim("worker-1");

        // Retry comfortably into the future: not claimable now.
        await q.retry(
          id,
          "worker-1",
          { code: "llm_timeout", retryable: true },
          new Date(Date.now() + 60_000),
        );
        await expect(queueFor().claim("worker-2")).resolves.toBeNull();

        // Once run_at has elapsed (simulated by moving it into the past), the same
        // job is claimable again, still carrying its bumped retry_count. claim gates
        // only on run_at <= now, so this proves the deferral is purely durable.
        await handle.db
          .update(jobs)
          .set({ runAt: new Date(Date.now() - 1) })
          .where(eq(jobs.id, id));
        const reclaimed = await queueFor().claim("worker-2");
        expect(reclaimed!.id).toBe(id);
        expect(reclaimed!.retryCount).toBe(1);
      });

      it("only retries a running job — pending or terminal jobs are rejected", async () => {
        const q = queueFor();
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });

        // pending → retry is illegal (never claimed).
        await expect(
          q.retry(id, "worker-1", { code: "x" }, new Date()),
        ).rejects.toBeInstanceOf(InvalidJobTransitionError);

        await q.claim("worker-1");
        await q.complete(id, "worker-1");
        // done → retry is illegal.
        await expect(
          q.retry(id, "worker-1", { code: "x" }, new Date()),
        ).rejects.toBeInstanceOf(InvalidJobTransitionError);
      });

      it("accumulates retry_count across successive business retries, independent of attempt", async () => {
        const q = queueFor();
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });

        // Two claim→retry cycles; run_at in the past so it is immediately re-claimable.
        for (let i = 0; i < 2; i += 1) {
          const claimed = await queueFor().claim("worker-1");
          expect(claimed!.id).toBe(id);
          await q.retry(
            id,
            "worker-1",
            { code: "llm_rate_limited", retryable: true },
            new Date(Date.now() - 1),
          );
        }

        const job = await jobById(id);
        expect(job!.retryCount).toBe(2);
        expect(job!.attempt).toBe(0);
      });

      it("a tenant-scoped queue cannot retry another tenant’s job", async () => {
        const { id } = await queueFor().enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        await queueFor().claim("worker-1"); // running

        await expect(
          queueFor(tenantB).retry(
            id,
            "worker-1",
            { code: "x" },
            new Date(Date.now() + 1_000),
          ),
        ).rejects.toBeInstanceOf(InvalidJobTransitionError);
        expect((await jobById(id))!.status).toBe("running");
        expect((await jobById(id))!.retryCount).toBe(0);
      });

      it("is safe against a reaper race: once the reaper requeues the job, retry is rejected and nothing double-counts", async () => {
        const q = queueFor();
        const { id } = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        await q.claim("worker-dead");

        // Make the lease deterministically expired instead of depending on timing.
        await expireLease(id);

        // The reaper wins the race: running → pending, attempt incremented.
        expect((await queueFor().requeueExpired()).requeued).toBe(1);

        // The worker (which was mid-dispatch) now tries to schedule a business retry.
        // The job is no longer `running`, so the guarded UPDATE matches nothing.
        await expect(
          queueFor().retry(
            id,
            "worker-dead",
            { code: "llm_timeout", retryable: true },
            new Date(Date.now() + 1_000),
          ),
        ).rejects.toBeInstanceOf(InvalidJobTransitionError);

        // The reaper's recovery stands; the business retry did not also apply.
        const job = await jobById(id);
        expect(job!.status).toBe("pending");
        expect(job!.attempt).toBe(1);
        expect(job!.retryCount).toBe(0);
      });
    });

    describe("tenant isolation", () => {
      it("a tenant-scoped queue does not claim another tenant’s job", async () => {
        await queueFor().enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });

        // Tenant B's scoped queue sees only tenant B's jobs — none are pending.
        await expect(queueFor(tenantB).claim("worker-b")).resolves.toBeNull();
      });

      it("a tenant-scoped queue cannot complete or fail another tenant’s job", async () => {
        const { id } = await queueFor().enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        await queueFor().claim("worker-1"); // now running

        // B's scoped queue matches no row (tenant predicate excludes it).
        await expect(queueFor(tenantB).complete(id, "worker-1")).rejects.toBeInstanceOf(
          InvalidJobTransitionError,
        );
        await expect(
          queueFor(tenantB).fail(id, "worker-1", { code: "x" }),
        ).rejects.toBeInstanceOf(InvalidJobTransitionError);

        // The job is untouched and still completable by the unscoped worker.
        expect((await jobById(id))!.status).toBe("running");
        await queueFor().complete(id, "worker-1");
        expect((await jobById(id))!.status).toBe("done");
      });

      it("a tenant-scoped queue cannot release another tenant’s running job", async () => {
        const { id } = await queueFor().enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        await queueFor().claim("worker-1");

        await expect(queueFor(tenantB).release(id, "worker-1")).resolves.toEqual({
          outcome: "not_running",
          status: null,
        });

        const job = await jobById(id);
        expect(job!.status).toBe("running");
        expect(job!.lockedBy).toBe("worker-1");
      });

      it("a tenant-scoped queue only reaps its own expired jobs", async () => {
        const q = queueFor();
        const a = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        const b = await q.enqueue({
          tenantId: tenantB,
          runId: runB,
          stepKey: "first",
        });
        await q.claim("worker-1");
        await q.claim("worker-2");

        await expireLease(a.id);
        await expireLease(b.id);

        // Scoped to A: reaps A's job only.
        const result = await queueFor(tenantA).requeueExpired();
        expect(result.requeued).toBe(1);
        expect(result.deadLettered).toEqual([]);

        expect((await jobById(a.id))!.status).toBe("pending");
        expect((await jobById(b.id))!.status).toBe("running");
      });

      it("a tenant-scoped queue does not dead-letter another tenant’s exhausted job", async () => {
        const q = queueFor();
        const a = await q.enqueue({
          tenantId: tenantA,
          runId: runA,
          stepKey: "first",
        });
        const b = await q.enqueue({
          tenantId: tenantB,
          runId: runB,
          stepKey: "first",
        });
        await q.claim("worker-1");
        await q.claim("worker-2");

        // Identical state: both expired, both at the ceiling. The tenant
        // predicate is the only thing that separates them.
        await expireLease(a.id, MAX_CRASH_ATTEMPTS);
        await expireLease(b.id, MAX_CRASH_ATTEMPTS);

        const result = await queueFor(tenantA).requeueExpired();
        expect(result.deadLettered.map((j) => j.id)).toEqual([a.id]);
        expect(result.deadLettered[0]!.tenantId).toBe(tenantA);

        expect((await jobById(a.id))!.status).toBe("failed");
        // B's job is untouched: still running, still leased, no error written.
        const other = await jobById(b.id);
        expect(other!.status).toBe("running");
        expect(other!.lastError).toBeNull();
        expect(other!.lockedBy).not.toBeNull();
      });
    });
  },
);
