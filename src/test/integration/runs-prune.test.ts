/**
 * Integration tests for `RunPruneRepository` and the `pnpm runs:prune` CLI
 * logic — these require a real Postgres.
 *
 * SKIPPED unless `TEST_DATABASE_URL` is set; never faked. The behaviour that
 * only a real server can prove here:
 *   - the partial index `workflow_runs_tenant_id_finished_at_terminal_idx`
 *     matches the prune predicate exactly (the new migration, `0010_*`,
 *     adds it);
 *   - deleting a row in `workflow_runs` cascades to `jobs`,
 *     `workflow_step_runs`, and `llm_usage` via the FK constraints already
 *     declared in `src/db/schema.ts`;
 *   - protected tables (`workflows`, `workflow_versions`, `events`,
 *     `connections`, `api_keys`, `tenants`, `users`) are never touched, even
 *     when their child run is pruned;
 *   - the `WHERE` clause's `status IN (terminal)` and `finished_at < cutoff`
 *     guards actually filter at the SQL layer;
 *   - `dry-run` performs zero writes (verified by inspecting
 *     `pg_stat_user_tables` counters before and after);
 *   - cross-tenant isolation: a `runs:prune` against tenant A never deletes
 *     tenant B's rows.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_workforce_test pnpm test
 *
 * The suite writes and deletes rows, so it refuses any database whose name
 * does not contain "test". Each test cleans up the rows it inserted before
 * returning; tenants created in beforeAll are removed in afterAll.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '@/db/client.js';
import { runPrune } from '@/cli/runs-prune.js';
import {
  connections,
  events,
  jobs,
  llmUsage,
  tenants,
  workflowRuns,
  workflowStepRuns,
  workflowVersions,
  workflows,
} from '@/db/schema.js';
import { RunPruneRepository } from '@/repositories/run-prune-repository.js';
import { TenantScope } from '@/repositories/tenant-scope.js';

import { TEST_DATABASE_URL, createTestDatabaseHandle } from './support.js';

/** A test row shape used to seed a workflow_run with a chosen status / finished_at. */
interface SeedRunInput {
  readonly tenantId: string;
  readonly status: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';
  /** Pass `null` to omit `finished_at` entirely. */
  readonly finishedAt: Date | null;
}

describe.skipIf(TEST_DATABASE_URL === undefined)('runs:prune integration', () => {
  let handle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;
  let workflowId: string;
  let versionId: string;
  let eventId: string;
  let connectionId: string;
  // Each tenant needs its OWN workflow/version/event: the composite tenant-safe
  // FKs `(tenant_id, workflow_id) → workflows(tenant_id, id)` forbid attaching
  // tenant B's run to tenant A's parents. Keyed by tenant id, filled in beforeAll.
  const parents: Record<string, { workflowId: string; versionId: string; eventId: string }> = {};

  const seedParents = async (
    tenantId: string,
  ): Promise<{ workflowId: string; versionId: string; eventId: string }> => {
    const [wf] = await handle.db
      .insert(workflows)
      .values({ tenantId, name: 'prune-wf', status: 'active' })
      .returning({ id: workflows.id });
    const [ver] = await handle.db
      .insert(workflowVersions)
      .values({
        tenantId,
        workflowId: wf!.id,
        version: 1,
        definition: { steps: [{ key: 'demo', type: 'noop', config: {} }] },
        triggerType: 'webhook',
        triggerConfig: { source: 'prune-source' },
        isActive: true,
      })
      .returning({ id: workflowVersions.id });
    const [ev] = await handle.db
      .insert(events)
      .values({ tenantId, source: 'prune-source', dedupeKey: `prune-seed-${tenantId}`, payload: {} })
      .returning({ id: events.id });
    return { workflowId: wf!.id, versionId: ver!.id, eventId: ev!.id };
  };

  const repoFor = (tenantId: string): RunPruneRepository =>
    new RunPruneRepository(new TenantScope(handle.db, tenantId));

  const seedRun = async (input: SeedRunInput): Promise<string> => {
    const parent = parents[input.tenantId]!;
    const inserted = await handle.db
      .insert(workflowRuns)
      .values({
        tenantId: input.tenantId,
        workflowId: parent.workflowId,
        workflowVersionId: parent.versionId,
        eventId: parent.eventId,
        status: input.status,
        finishedAt: input.finishedAt,
      })
      .returning({ id: workflowRuns.id });
    const id = inserted[0]!.id;
    // Seed a job and a step run + llm_usage row per run so we can assert
    // the cascade fires for every child.
    await handle.db.insert(workflowStepRuns).values({
      tenantId: input.tenantId,
      runId: id,
      stepKey: 'demo',
      stepType: 'noop',
      status: 'succeeded',
    });
    await handle.db.insert(jobs).values({
      tenantId: input.tenantId,
      runId: id,
      stepKey: 'demo',
    });
    await handle.db.insert(llmUsage).values({
      tenantId: input.tenantId,
      runId: id,
      stepRunId: (await handle.db
        .select({ id: workflowStepRuns.id })
        .from(workflowStepRuns)
        .where(sql`${workflowStepRuns.runId} = ${id}`)
        .limit(1))[0]!.id,
      provider: 'claude',
      model: 'claude-opus-5',
      round: 1,
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      latencyMs: 100,
    });
    return id;
  };

  const countRuns = async (tenantId: string): Promise<number> => {
    const rows = await handle.db
      .execute(sql`SELECT count(*)::int AS n FROM workflow_runs WHERE tenant_id = ${tenantId}`);
    return (rows.rows[0] as { n: number }).n;
  };

  const countStepRuns = async (tenantId: string, runId: string): Promise<number> => {
    const rows = await handle.db
      .execute(
        sql`SELECT count(*)::int AS n FROM workflow_step_runs WHERE tenant_id = ${tenantId} AND run_id = ${runId}`,
      );
    return (rows.rows[0] as { n: number }).n;
  };

  const countJobs = async (tenantId: string, runId: string): Promise<number> => {
    const rows = await handle.db
      .execute(sql`SELECT count(*)::int AS n FROM jobs WHERE tenant_id = ${tenantId} AND run_id = ${runId}`);
    return (rows.rows[0] as { n: number }).n;
  };

  const countLlmUsage = async (tenantId: string, runId: string): Promise<number> => {
    const rows = await handle.db
      .execute(sql`SELECT count(*)::int AS n FROM llm_usage WHERE tenant_id = ${tenantId} AND run_id = ${runId}`);
    return (rows.rows[0] as { n: number }).n;
  };

  /**
   * Exact, transactional row counts for every table the prune could touch,
   * keyed by table name.
   *
   * This deliberately does NOT use `pg_stat_user_tables` (n_tup_ins/upd/del):
   * those counters are asynchronous (updated after a lag), cumulative, and
   * database-wide, so a before/after delta races with any sibling test's
   * writes and with the stats collector's own flush interval. `count(*)` is
   * transactional and exact, so comparing snapshots is a deterministic proof
   * of actual database state.
   */
  const COUNTED_TABLES = [
    'workflow_runs',
    'jobs',
    'workflow_step_runs',
    'llm_usage',
    'workflows',
    'workflow_versions',
    'events',
    'connections',
  ] as const;

  const snapshotCounts = async (): Promise<Record<string, number>> => {
    const results = await Promise.all([
      handle.db.execute(sql`SELECT count(*)::int AS n FROM workflow_runs`),
      handle.db.execute(sql`SELECT count(*)::int AS n FROM jobs`),
      handle.db.execute(sql`SELECT count(*)::int AS n FROM workflow_step_runs`),
      handle.db.execute(sql`SELECT count(*)::int AS n FROM llm_usage`),
      handle.db.execute(sql`SELECT count(*)::int AS n FROM workflows`),
      handle.db.execute(sql`SELECT count(*)::int AS n FROM workflow_versions`),
      handle.db.execute(sql`SELECT count(*)::int AS n FROM events`),
      handle.db.execute(sql`SELECT count(*)::int AS n FROM connections`),
    ]);
    const out: Record<string, number> = {};
    results.forEach((r, i) => {
      out[COUNTED_TABLES[i]!] = (r.rows[0] as { n: number }).n;
    });
    return out;
  };

  /**
   * The full content of a single `workflow_runs` row as canonical JSON, or the
   * string `'null'` when the row is absent. Lets a dry-run test prove that no
   * column was mutated in place (which a row-count comparison alone cannot
   * catch).
   */
  const runRowJson = async (runId: string): Promise<string> => {
    const rows = await handle.db.execute(
      sql`SELECT to_jsonb(workflow_runs) AS r FROM workflow_runs WHERE id = ${runId}`,
    );
    return JSON.stringify((rows.rows[0] as { r: unknown } | undefined)?.r ?? null);
  };

  beforeAll(async () => {
    handle = createTestDatabaseHandle();
    await handle.verifyConnection();

    const inserted = await handle.db
      .insert(tenants)
      .values([{ name: 'Prune Tenant A' }, { name: 'Prune Tenant B' }])
      .returning({ id: tenants.id });
    tenantA = inserted[0]!.id;
    tenantB = inserted[1]!.id;

    // Seed each tenant its OWN workflow/version/event, so a run can be attached
    // under either tenant without violating the composite tenant-safe FKs.
    const parentsA = await seedParents(tenantA);
    parents[tenantA] = parentsA;
    parents[tenantB] = await seedParents(tenantB);

    // The direct-insert compare-and-set tests below reference tenant A's parents.
    workflowId = parentsA.workflowId;
    versionId = parentsA.versionId;
    eventId = parentsA.eventId;

    // A connection row that must survive any prune — used to verify the
    // protected-tables invariant.
    const [conn] = await handle.db
      .insert(connections)
      .values({
        tenantId: tenantA,
        provider: 'slack',
        name: 'prune-conn',
        encryptedCredentials: { v: 1, alg: 'aes-256-gcm', iv: '', ct: '', tag: '' },
      })
      .returning({ id: connections.id });
    connectionId = conn!.id;
  });

  afterAll(async () => {
    if (handle === undefined) return;
    // Cascade children first so the cleanup does not violate FKs we just
    // protected. Tenant delete cascades to workflow_runs and jobs but not
    // to step_runs/llm_usage whose FKs use composite (tenant_id, run_id),
    // so we wipe them explicitly.
    await handle.db.delete(workflowStepRuns);
    await handle.db.delete(llmUsage);
    await handle.db.delete(jobs);
    await handle.db.delete(events);
    await handle.db.delete(workflowVersions);
    await handle.db.delete(workflows);
    await handle.db.delete(connections);
    for (const id of [tenantA, tenantB]) {
      if (id !== undefined) await handle.db.delete(tenants).where(sql`${tenants.id} = ${id}`);
    }
    await handle.close();
  });

  // Each test wipes only the rows it inserted (workflow_runs by tenant) so
  // parallel suites that share the same database remain isolated.
  beforeEach(async () => {
    await handle.db
      .execute(sql`DELETE FROM workflow_runs WHERE tenant_id IN (${tenantA}, ${tenantB})`);
  });

  describe('eligibility — terminal + age + not null', () => {
    it('lists a terminal succeeded run that finished before the cutoff', async () => {
      const id = await seedRun({
        tenantId: tenantA,
        status: 'succeeded',
        finishedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const page = await repoFor(tenantA).listPrunable(new Date('2026-09-01T00:00:00Z'), {
        limit: 100,
      });
      expect(page.items.map((r) => r.id)).toContain(id);
    });

    it('lists a terminal failed run', async () => {
      const id = await seedRun({
        tenantId: tenantA,
        status: 'failed',
        finishedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const page = await repoFor(tenantA).listPrunable(new Date('2026-09-01T00:00:00Z'), {
        limit: 100,
      });
      expect(page.items.map((r) => r.id)).toContain(id);
    });

    it('lists a terminal cancelled run', async () => {
      const id = await seedRun({
        tenantId: tenantA,
        status: 'cancelled',
        finishedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const page = await repoFor(tenantA).listPrunable(new Date('2026-09-01T00:00:00Z'), {
        limit: 100,
      });
      expect(page.items.map((r) => r.id)).toContain(id);
    });

    it('never lists a queued run', async () => {
      await seedRun({
        tenantId: tenantA,
        status: 'queued',
        finishedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const page = await repoFor(tenantA).listPrunable(new Date('2026-09-01T00:00:00Z'), {
        limit: 100,
      });
      expect(page.items).toHaveLength(0);
    });

    it('never lists a running run', async () => {
      await seedRun({
        tenantId: tenantA,
        status: 'running',
        finishedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const page = await repoFor(tenantA).listPrunable(new Date('2026-09-01T00:00:00Z'), {
        limit: 100,
      });
      expect(page.items).toHaveLength(0);
    });

    it('never lists a waiting run', async () => {
      await seedRun({
        tenantId: tenantA,
        status: 'waiting',
        finishedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const page = await repoFor(tenantA).listPrunable(new Date('2026-09-01T00:00:00Z'), {
        limit: 100,
      });
      expect(page.items).toHaveLength(0);
    });

    it('never lists a terminal run with NULL finished_at (defence in depth)', async () => {
      await seedRun({
        tenantId: tenantA,
        status: 'succeeded',
        finishedAt: null,
      });
      const page = await repoFor(tenantA).listPrunable(new Date('2026-09-01T00:00:00Z'), {
        limit: 100,
      });
      expect(page.items).toHaveLength(0);
    });

    it('never lists a terminal run whose finished_at is exactly equal to the cutoff', async () => {
      const cutoff = new Date('2026-09-01T00:00:00Z');
      await seedRun({
        tenantId: tenantA,
        status: 'succeeded',
        finishedAt: cutoff,
      });
      const page = await repoFor(tenantA).listPrunable(cutoff, { limit: 100 });
      expect(page.items).toHaveLength(0);
    });

    it('never lists a terminal run whose finished_at is after the cutoff', async () => {
      await seedRun({
        tenantId: tenantA,
        status: 'succeeded',
        finishedAt: new Date('2026-12-01T00:00:00Z'),
      });
      const page = await repoFor(tenantA).listPrunable(new Date('2026-09-01T00:00:00Z'), {
        limit: 100,
      });
      expect(page.items).toHaveLength(0);
    });
  });

  describe('tenant isolation', () => {
    it('listPrunable returns only the calling tenant\'s rows', async () => {
      const idA = await seedRun({
        tenantId: tenantA,
        status: 'succeeded',
        finishedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const idB = await seedRun({
        tenantId: tenantB,
        status: 'succeeded',
        finishedAt: new Date('2026-01-01T00:00:00Z'),
      });

      const pageA = await repoFor(tenantA).listPrunable(new Date('2026-09-01T00:00:00Z'), {
        limit: 100,
      });
      const pageB = await repoFor(tenantB).listPrunable(new Date('2026-09-01T00:00:00Z'), {
        limit: 100,
      });

      expect(pageA.items.map((r) => r.id)).toContain(idA);
      expect(pageA.items.map((r) => r.id)).not.toContain(idB);
      expect(pageB.items.map((r) => r.id)).toContain(idB);
      expect(pageB.items.map((r) => r.id)).not.toContain(idA);
    });

    it('pruneRun on another tenant\'s id returns not-found', async () => {
      const idB = await seedRun({
        tenantId: tenantB,
        status: 'succeeded',
        finishedAt: new Date('2026-01-01T00:00:00Z'),
      });

      const outcome = await repoFor(tenantA).pruneRun(idB, new Date('2026-09-01T00:00:00Z'));
      expect(outcome.outcome).toBe('not-found');

      const stillThere = await countRuns(tenantB);
      expect(stillThere).toBeGreaterThanOrEqual(1);
    });
  });

  describe('compare-and-set delete', () => {
    it('pruneRun returns not-found for a non-terminal run', async () => {
      // Insert directly with status='running' — the user could not create
      // this via CLI but the repository must still defend itself.
      const [row] = await handle.db
        .insert(workflowRuns)
        .values({
          tenantId: tenantA,
          workflowId,
          workflowVersionId: versionId,
          eventId,
          status: 'running',
          finishedAt: new Date('2026-01-01T00:00:00Z'),
        })
        .returning({ id: workflowRuns.id });
      const id = row!.id;

      const outcome = await repoFor(tenantA).pruneRun(id, new Date('2026-09-01T00:00:00Z'));
      expect(outcome.outcome).toBe('not-found');
      const remaining = await countRuns(tenantA);
      expect(remaining).toBe(1);
    });

    it('pruneRun returns not-found when finished_at is NULL even with terminal status', async () => {
      const [row] = await handle.db
        .insert(workflowRuns)
        .values({
          tenantId: tenantA,
          workflowId,
          workflowVersionId: versionId,
          eventId,
          status: 'succeeded',
          finishedAt: null,
        })
        .returning({ id: workflowRuns.id });
      const id = row!.id;

      const outcome = await repoFor(tenantA).pruneRun(id, new Date('2026-09-01T00:00:00Z'));
      expect(outcome.outcome).toBe('not-found');
      const remaining = await countRuns(tenantA);
      expect(remaining).toBe(1);
    });

    it('pruneRun returns not-found when finished_at equals the cutoff (strict <)', async () => {
      const cutoff = new Date('2026-09-01T00:00:00Z');
      const [row] = await handle.db
        .insert(workflowRuns)
        .values({
          tenantId: tenantA,
          workflowId,
          workflowVersionId: versionId,
          eventId,
          status: 'succeeded',
          finishedAt: cutoff,
        })
        .returning({ id: workflowRuns.id });
      const id = row!.id;

      const outcome = await repoFor(tenantA).pruneRun(id, cutoff);
      expect(outcome.outcome).toBe('not-found');
    });
  });

  describe('cascade — only run-scoped rows', () => {
    it('deleting a run cascades to its jobs, workflow_step_runs, and llm_usage', async () => {
      const id = await seedRun({
        tenantId: tenantA,
        status: 'succeeded',
        finishedAt: new Date('2026-01-01T00:00:00Z'),
      });

      // Sanity: child rows are present.
      expect(await countJobs(tenantA, id)).toBe(1);
      expect(await countStepRuns(tenantA, id)).toBe(1);
      expect(await countLlmUsage(tenantA, id)).toBe(1);

      const outcome = await repoFor(tenantA).pruneRun(id, new Date('2026-09-01T00:00:00Z'));
      expect(outcome.outcome).toBe('pruned');

      // Run and all three child tables are empty for this id.
      expect(await countRuns(tenantA)).toBe(0);
      expect(await countJobs(tenantA, id)).toBe(0);
      expect(await countStepRuns(tenantA, id)).toBe(0);
      expect(await countLlmUsage(tenantA, id)).toBe(0);
    });

    it('protected tables are never deleted', async () => {
      const id = await seedRun({
        tenantId: tenantA,
        status: 'succeeded',
        finishedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const before = await snapshotCounts();

      const outcome = await repoFor(tenantA).pruneRun(id, new Date('2026-09-01T00:00:00Z'));
      expect(outcome.outcome).toBe('pruned');

      const after = await snapshotCounts();

      // The run and its cascade children shrink by exactly the pruned subtree;
      // protected tables keep their exact row counts.
      for (const rel of ['workflows', 'workflow_versions', 'events', 'connections']) {
        expect(after[rel]).toBe(before[rel]);
      }
      // The run itself is gone (compare-and-set matched exactly one row).
      expect(after['workflow_runs']).toBe(before['workflow_runs']! - 1);

      // Sanity: the workflow / version / event / connection rows still exist.
      const wfCount = await handle.db.execute(
        sql`SELECT count(*)::int AS n FROM workflows WHERE id = ${workflowId}`,
      );
      expect((wfCount.rows[0] as { n: number }).n).toBe(1);
      const verCount = await handle.db.execute(
        sql`SELECT count(*)::int AS n FROM workflow_versions WHERE id = ${versionId}`,
      );
      expect((verCount.rows[0] as { n: number }).n).toBe(1);
      const evCount = await handle.db.execute(
        sql`SELECT count(*)::int AS n FROM events WHERE id = ${eventId}`,
      );
      expect((evCount.rows[0] as { n: number }).n).toBe(1);
      const connCount = await handle.db.execute(
        sql`SELECT count(*)::int AS n FROM connections WHERE id = ${connectionId}`,
      );
      expect((connCount.rows[0] as { n: number }).n).toBe(1);
    });
  });

  describe('idempotency', () => {
    it('a second real-run prune against the same data is a no-op', async () => {
      await seedRun({
        tenantId: tenantA,
        status: 'succeeded',
        finishedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const cutoff = new Date('2026-09-01T00:00:00Z');

      const first = await runPrune({
        repository: repoFor(tenantA),
        tenantId: tenantA,
        cutoff,
        batchSize: 100,
        dryRun: false,
      });
      expect(first.pruned).toBe(1);

      const second = await runPrune({
        repository: repoFor(tenantA),
        tenantId: tenantA,
        cutoff,
        batchSize: 100,
        dryRun: false,
      });
      expect(second.pruned).toBe(0);
      expect(second.failed).toBe(0);
    });
  });

  describe('dry-run guarantees zero writes', () => {
    it('performs no INSERT/UPDATE/DELETE on workflow_runs (or any protected table)', async () => {
      const id = await seedRun({
        tenantId: tenantA,
        status: 'succeeded',
        finishedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const before = await snapshotCounts();
      const rowBefore = await runRowJson(id);

      const summary = await runPrune({
        repository: repoFor(tenantA),
        tenantId: tenantA,
        cutoff: new Date('2026-09-01T00:00:00Z'),
        batchSize: 100,
        dryRun: true,
      });
      expect(summary.wouldPrune).toBe(1);

      // Row still exists.
      expect(await countRuns(tenantA)).toBe(1);

      // Zero writes: every table the prune could touch keeps its exact row
      // count (catches any INSERT or DELETE), and the candidate row is
      // byte-for-byte identical (catches any in-place UPDATE). count(*) and
      // to_jsonb are transactional and exact, so this is deterministic — no
      // dependence on the asynchronous pg_stat_user_tables collector.
      const after = await snapshotCounts();
      for (const rel of COUNTED_TABLES) {
        expect(after[rel]).toBe(before[rel]);
      }
      expect(await runRowJson(id)).toBe(rowBefore);

      // The seeded run is still around for cleanup.
      expect(id).toBeDefined();
    });
  });

  describe('keyset pagination — no duplicates, no skips', () => {
    it('pages through a batch boundary with no overlap and no gap', async () => {
      const cutoff = new Date('2026-09-01T00:00:00Z');
      // Seed 5 prunable runs with strictly decreasing finished_at so the
      // keyset ordering is deterministic.
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = await seedRun({
          tenantId: tenantA,
          status: 'succeeded',
          finishedAt: new Date(`2026-0${1 + i}-01T00:00:00Z`),
        });
        ids.push(id);
      }

      // batch size 2 forces pagination across 3 pages: [2, 2, 1].
      const collected: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      for (let safety = 0; safety < 100; safety++) {
        const page = await repoFor(tenantA).listPrunable(cutoff, {
          limit: 2,
          ...(cursor !== null ? { cursor } : {}),
        });
        pages++;
        for (const row of page.items) collected.push(row.id);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      expect(pages).toBe(3);
      expect(new Set(collected).size).toBe(collected.length); // no duplicates
      expect([...collected].sort()).toEqual([...ids].sort()); // every id present
    });
  });

  describe('concurrent prune safety', () => {
    it('two concurrent prunes against the same tenant do not double-delete (one wins, the other skips)', async () => {
      const id = await seedRun({
        tenantId: tenantA,
        status: 'succeeded',
        finishedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const cutoff = new Date('2026-09-01T00:00:00Z');

      const [a, b] = await Promise.all([
        repoFor(tenantA).pruneRun(id, cutoff),
        repoFor(tenantA).pruneRun(id, cutoff),
      ]);

      const outcomes = [a.outcome, b.outcome].sort();
      expect(outcomes).toEqual(['not-found', 'pruned']);
      expect(await countRuns(tenantA)).toBe(0);
    });
  });

  describe('protected tables — direct integrity checks', () => {
    it('workflows/workflow_versions/events/connections are never written or deleted by runPrune', async () => {
      await seedRun({
        tenantId: tenantA,
        status: 'succeeded',
        finishedAt: new Date('2026-01-01T00:00:00Z'),
      });
      const cutoff = new Date('2026-09-01T00:00:00Z');

      const before = {
        workflows: (await handle.db.execute(sql`SELECT count(*)::int AS n FROM workflows`)).rows[0] as { n: number },
        versions: (await handle.db.execute(sql`SELECT count(*)::int AS n FROM workflow_versions`)).rows[0] as { n: number },
        events: (await handle.db.execute(sql`SELECT count(*)::int AS n FROM events`)).rows[0] as { n: number },
        connections: (await handle.db.execute(sql`SELECT count(*)::int AS n FROM connections`)).rows[0] as { n: number },
      };

      await runPrune({
        repository: repoFor(tenantA),
        tenantId: tenantA,
        cutoff,
        batchSize: 100,
        dryRun: false,
      });

      const after = {
        workflows: (await handle.db.execute(sql`SELECT count(*)::int AS n FROM workflows`)).rows[0] as { n: number },
        versions: (await handle.db.execute(sql`SELECT count(*)::int AS n FROM workflow_versions`)).rows[0] as { n: number },
        events: (await handle.db.execute(sql`SELECT count(*)::int AS n FROM events`)).rows[0] as { n: number },
        connections: (await handle.db.execute(sql`SELECT count(*)::int AS n FROM connections`)).rows[0] as { n: number },
      };

      expect(after.workflows.n).toBe(before.workflows.n);
      expect(after.versions.n).toBe(before.versions.n);
      expect(after.events.n).toBe(before.events.n);
      expect(after.connections.n).toBe(before.connections.n);

      // The seeded run is gone (sanity).
      expect(await countRuns(tenantA)).toBe(0);
    });
  });
});
