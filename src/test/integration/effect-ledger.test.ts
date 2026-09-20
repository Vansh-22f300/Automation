/**
 * Integration tests for the PostgreSQL effect ledger — these require a real Postgres.
 *
 * SKIPPED unless `TEST_DATABASE_URL` is set; never faked. The ledger's entire
 * correctness rests on behaviour only a real server exhibits: one uniqueness
 * constraint (`tenant_id, idempotency_key`) arbitrating concurrent reservations, and
 * compare-and-swap UPDATEs whose "matched zero rows" outcome is a lost race. A mock
 * cannot prove either, so if the variable is absent the suite reports skipped.
 *
 *   TEST_DATABASE_URL=postgresql://…/ai_workforce_test pnpm test
 *
 * What these prove that the offline unit tests cannot:
 *   - a fresh reservation is `acquired`, and settling success stores the result;
 *   - a second attempt on a succeeded effect `replay`s the stored result — it is
 *     NEVER re-run (the lost-settlement guard);
 *   - a SAFE retryable failure `release`s the reservation (owner NULL, still
 *     pending), so the next attempt genuinely re-acquires and re-runs;
 *   - an AMBIGUOUS failure is terminal — a later attempt sees `ambiguous`, never
 *     re-runs;
 *   - a deterministic failure is terminal `failed`;
 *   - two concurrent `acquire`s on the same key yield exactly ONE `acquired`;
 *   - an attempt that crashed holding a reservation (owner set, lease expired) is
 *     settled `ambiguous` by the next attempt, which does NOT re-run;
 *   - a LIVE reservation held by another attempt makes this one `defer` with a
 *     `retryAfterMs` past the live lease horizon;
 *   - a superseded attempt's settlement is a no-op (CAS guard on the owner);
 *   - a ledger scoped to one tenant cannot observe another tenant's reservation.
 *
 * The suite writes and deletes rows, so it refuses any database whose name does not
 * contain "test", and wipes tool_effects between tests for isolation.
 */

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '@/db/client.js';
import { toolEffects, tenants } from '@/db/schema.js';
import type { EffectReservation } from '@/domain/effect-ledger.js';
import { newId } from '@/domain/ids.js';
import { DEFAULT_EFFECT_LEASE_MS } from '@/domain/timing.js';
import { EffectLedgerRepository } from '@/repositories/effect-ledger-repository.js';
import { PostgresJobQueue } from '@/repositories/job-queue.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import { WebhookRepository } from '@/repositories/webhook-repository.js';
import { WorkflowRepository } from '@/repositories/workflow-repository.js';

import { TEST_DATABASE_URL, createTestDatabaseHandle } from './support.js';

const definition = () => ({
  version: 1,
  steps: [{ key: 'first', type: 'noop', config: {} }],
});

describe.skipIf(TEST_DATABASE_URL === undefined)('postgres effect ledger integration', () => {
  let handle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;
  let runA: string;
  let runB: string;

  // The owner token is a stepRunId in production — a UUID. Use real ids, not labels,
  // so the column's uuid type is exercised exactly as it is at runtime.
  const OWNER_1 = newId();
  const OWNER_2 = newId();
  const OWNER_B = newId();

  const seedRun = async (tenantId: string, source: string): Promise<string> => {
    const workflows = new WorkflowRepository(new TenantScope(handle.db, tenantId));
    await workflows.create({
      name: `wf-${source}`,
      definition: definition(),
      triggerType: 'webhook',
      triggerConfig: { source },
    });
    const ingestor = new WebhookRepository(new TenantScope(handle.db, tenantId), new PostgresJobQueue(handle.db));
    const result = await ingestor.ingest({ source, dedupeKey: `seed-${source}`, payload: {} });
    return result.runId as string;
  };

  /** A reservation for tenantA/runA with an overridable owner and key. */
  const reservationFor = (overrides: Partial<EffectReservation> = {}): EffectReservation => ({
    tenantId: tenantA,
    runId: runA,
    stepKey: 'first',
    toolName: 'slack.post',
    ordinal: 1,
    idempotencyKey: `${runA}:first:slack.post:1`,
    provider: 'slack',
    owner: OWNER_1,
    leaseMs: DEFAULT_EFFECT_LEASE_MS,
    ...overrides,
  });

  const rowFor = async (idempotencyKey: string) => {
    const [row] = await handle.db
      .select()
      .from(toolEffects)
      .where(and(eq(toolEffects.tenantId, tenantA), eq(toolEffects.idempotencyKey, idempotencyKey)))
      .limit(1);
    return row;
  };

  beforeAll(async () => {
    handle = createTestDatabaseHandle();
    await handle.verifyConnection();
    const inserted = await handle.db
      .insert(tenants)
      .values([{ name: 'Effect Tenant A' }, { name: 'Effect Tenant B' }])
      .returning({ id: tenants.id });
    tenantA = inserted[0]!.id;
    tenantB = inserted[1]!.id;
    runA = await seedRun(tenantA, 'effect-a');
    runB = await seedRun(tenantB, 'effect-b');
  });

  afterAll(async () => {
    if (handle === undefined) return;
    for (const id of [tenantA, tenantB]) {
      if (id !== undefined) await handle.db.delete(tenants).where(eq(tenants.id, id));
    }
    await handle.close();
  });

  beforeEach(async () => {
    await handle.db.delete(toolEffects);
  });

  describe('reserve → settle success → replay', () => {
    it('acquires a fresh reservation and stores the result on success', async () => {
      const ledger = new EffectLedgerRepository(handle.db, tenantA);
      const reservation = reservationFor();

      const acquisition = await ledger.acquire(reservation);
      expect(acquisition.kind).toBe('acquired');

      await ledger.settleSuccess(reservation, { ts: '123.456' });

      const row = await rowFor(reservation.idempotencyKey);
      expect(row!.state).toBe('succeeded');
      expect(row!.result).toEqual({ ts: '123.456' });
      expect(row!.leaseExpiresAt).toBeNull();
    });

    it('replays a succeeded effect for a later attempt — never re-runs it', async () => {
      const ledger = new EffectLedgerRepository(handle.db, tenantA);
      const reservation = reservationFor();
      await ledger.acquire(reservation);
      await ledger.settleSuccess(reservation, { ts: '123.456' });

      // A different attempt (fresh owner) observes the succeeded row.
      const replayLedger = new EffectLedgerRepository(handle.db, tenantA);
      const acquisition = await replayLedger.acquire(reservationFor({ owner: OWNER_2 }));
      expect(acquisition).toEqual({ kind: 'replay', result: { ts: '123.456' } });
    });
  });

  describe('settle failure dispositions', () => {
    it('release: returns a SAFE-retryable reservation to pending (owner NULL) so the next attempt re-acquires', async () => {
      const ledger = new EffectLedgerRepository(handle.db, tenantA);
      const reservation = reservationFor();
      await ledger.acquire(reservation);

      await ledger.settleFailure(reservation, {
        kind: 'release',
        error: { code: 'slack_rate_limited', message: 'rate limited', retryable: true },
      });

      const row = await rowFor(reservation.idempotencyKey);
      expect(row!.state).toBe('pending');
      expect(row!.owner).toBeNull();

      // The next attempt genuinely re-acquires the released reservation.
      const next = new EffectLedgerRepository(handle.db, tenantA);
      const acquisition = await next.acquire(reservationFor({ owner: OWNER_2 }));
      expect(acquisition.kind).toBe('acquired');
      const reacquired = await rowFor(reservation.idempotencyKey);
      expect(reacquired!.owner).toBe(OWNER_2);
    });

    it('permanent: settles failed terminally; a later attempt re-throws, never re-runs', async () => {
      const ledger = new EffectLedgerRepository(handle.db, tenantA);
      const reservation = reservationFor();
      await ledger.acquire(reservation);
      await ledger.settleFailure(reservation, {
        kind: 'permanent',
        error: { code: 'slack_bad_request', message: 'invalid channel', retryable: false },
      });

      const row = await rowFor(reservation.idempotencyKey);
      expect(row!.state).toBe('failed');

      const next = new EffectLedgerRepository(handle.db, tenantA);
      const acquisition = await next.acquire(reservationFor({ owner: OWNER_2 }));
      expect(acquisition.kind).toBe('failed');
    });

    it('ambiguous: settles ambiguous terminally; a later attempt sees ambiguous, never re-runs', async () => {
      const ledger = new EffectLedgerRepository(handle.db, tenantA);
      const reservation = reservationFor();
      await ledger.acquire(reservation);
      await ledger.settleFailure(reservation, {
        kind: 'ambiguous',
        error: { code: 'slack_5xx', message: 'server error', retryable: true },
      });

      const row = await rowFor(reservation.idempotencyKey);
      expect(row!.state).toBe('ambiguous');

      const next = new EffectLedgerRepository(handle.db, tenantA);
      const acquisition = await next.acquire(reservationFor({ owner: OWNER_2 }));
      expect(acquisition.kind).toBe('ambiguous');
    });
  });

  describe('concurrency: one uniqueness constraint arbitrates', () => {
    it('two concurrent acquires on the same key yield exactly one acquired', async () => {
      const ledgerA = new EffectLedgerRepository(handle.db, tenantA);
      const ledgerB = new EffectLedgerRepository(handle.db, tenantA);

      const [a, b] = await Promise.all([
        ledgerA.acquire(reservationFor({ owner: OWNER_1 })),
        ledgerB.acquire(reservationFor({ owner: OWNER_2 })),
      ]);

      const kinds = [a.kind, b.kind].sort();
      // The loser observes a live reservation held by the winner → defer.
      expect(kinds).toEqual(['acquired', 'defer']);

      // Exactly one row exists, owned by one of the two attempts.
      const row = await rowFor(reservationFor().idempotencyKey);
      expect([OWNER_1, OWNER_2]).toContain(row!.owner);
    });
  });

  describe('crash recovery: owner set, lease expired → ambiguous', () => {
    it('settles a crashed attempt ambiguous on the next acquire and does not re-run', async () => {
      // Attempt 1 acquires, then "crashes": we force its lease into the past.
      const ledger = new EffectLedgerRepository(handle.db, tenantA);
      const reservation = reservationFor();
      await ledger.acquire(reservation);
      await handle.db
        .update(toolEffects)
        .set({ leaseExpiresAt: new Date(Date.now() - 1) })
        .where(and(eq(toolEffects.tenantId, tenantA), eq(toolEffects.idempotencyKey, reservation.idempotencyKey)));

      // Attempt 2 observes owner-set + lease-expired → ambiguous, never acquired.
      const next = new EffectLedgerRepository(handle.db, tenantA);
      const acquisition = await next.acquire(reservationFor({ owner: OWNER_2 }));
      expect(acquisition.kind).toBe('ambiguous');

      const row = await rowFor(reservation.idempotencyKey);
      expect(row!.state).toBe('ambiguous');
    });
  });

  describe('live-pending defer: another attempt holds a live lease', () => {
    it('defers with a retryAfterMs past the live lease horizon', async () => {
      // A fixed clock so the defer arithmetic is deterministic.
      const base = new Date('2026-01-01T00:00:00.000Z');
      const holder = new EffectLedgerRepository(handle.db, tenantA, { now: () => base });
      const reservation = reservationFor();
      await holder.acquire(reservation); // lease = base + 120s, live.

      // A second attempt at the same instant sees the live lease → defer.
      const next = new EffectLedgerRepository(handle.db, tenantA, { now: () => base });
      const acquisition = await next.acquire(reservationFor({ owner: OWNER_2 }));
      expect(acquisition.kind).toBe('defer');
      if (acquisition.kind === 'defer') {
        // remaining lease (120s) + settlement margin — comfortably past the lease.
        expect(acquisition.retryAfterMs).toBeGreaterThan(DEFAULT_EFFECT_LEASE_MS);
      }
      // The holder's reservation was never touched.
      const row = await rowFor(reservation.idempotencyKey);
      expect(row!.owner).toBe(OWNER_1);
      expect(row!.state).toBe('pending');
    });
  });

  describe('CAS guards', () => {
    it('a superseded attempt cannot settle a reservation another attempt took over', async () => {
      // Attempt 1 acquires, crashes (lease expired). Attempt 2 releases via a safe
      // re-acquire path is not applicable here; instead attempt 2 takes it over by
      // observing the expired lease → ambiguous. Attempt 1 then tries to settle
      // success and must be a no-op (its owner no longer matches a pending row).
      const one = new EffectLedgerRepository(handle.db, tenantA);
      const reservation = reservationFor({ owner: OWNER_1 });
      await one.acquire(reservation);
      await handle.db
        .update(toolEffects)
        .set({ leaseExpiresAt: new Date(Date.now() - 1) })
        .where(and(eq(toolEffects.tenantId, tenantA), eq(toolEffects.idempotencyKey, reservation.idempotencyKey)));

      const two = new EffectLedgerRepository(handle.db, tenantA);
      await two.acquire(reservationFor({ owner: OWNER_2 })); // → ambiguous, terminal

      // The superseded attempt 1 tries to record its success: must not overwrite.
      await one.settleSuccess(reservation, { ts: 'late' });

      const row = await rowFor(reservation.idempotencyKey);
      expect(row!.state).toBe('ambiguous');
      expect(row!.result).toBeNull();
    });
  });

  describe('tenant isolation', () => {
    it('a ledger scoped to tenant B cannot observe tenant A reservation', async () => {
      const ledgerA = new EffectLedgerRepository(handle.db, tenantA);
      await ledgerA.acquire(reservationFor());

      // Tenant B uses the SAME idempotency key string but its own run — the unique
      // constraint is (tenant_id, idempotency_key), so B gets its own fresh row.
      const ledgerB = new EffectLedgerRepository(handle.db, tenantB);
      const acquisition = await ledgerB.acquire({
        tenantId: tenantB,
        runId: runB,
        stepKey: 'first',
        toolName: 'slack.post',
        ordinal: 1,
        idempotencyKey: `${runA}:first:slack.post:1`,
        provider: 'slack',
        owner: OWNER_B,
        leaseMs: DEFAULT_EFFECT_LEASE_MS,
      });
      expect(acquisition.kind).toBe('acquired');
    });
  });
});
