/**
 * The PostgreSQL effect ledger — the persistence half of `@/domain/effect-ledger`.
 *
 * This is where the two-axis safety contract meets the database. Its whole job is
 * to make ONE uniqueness constraint (`tenant_id, idempotency_key` on `tool_effects`)
 * the sole arbiter of "who runs this external effect", and to move the reservation
 * through its four states with compare-and-swap UPDATEs that a superseded attempt
 * can never win.
 *
 * Two ideas do all the work, both borrowed from the job queue's proven approach:
 *
 *   1. **Atomic reservation, no read-first.** Acquisition is a single
 *      `INSERT … ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING`.
 *      A returned row means this attempt won the reservation; an empty result means
 *      someone already holds (or held) it, and we read the row and branch. There is
 *      no SELECT-before-INSERT, so there is no window in which two attempts both
 *      "see nothing" and both insert — the constraint decides, not application code.
 *
 *   2. **CAS transitions, guarded by owner + state.** Every settlement is an
 *      `UPDATE … WHERE idempotency_key = $ AND state = 'pending' AND owner = $me`
 *      (or the equivalent for a released/crashed row). An UPDATE that matches no
 *      row is how "your lease was superseded" surfaces — the same discipline the
 *      queue uses, where a transition that touches zero rows is a lost race, not a
 *      silent success.
 *
 * The class is bound to one tenant through `TenantScope` — it extends
 * `TenantScopedRepository`, exactly like every other tenant-scoped repository, so
 * `this.tenantId` comes from the scope and every statement carries a `tenant_id`
 * predicate. A key from another tenant simply is not found. (A ledger is built per
 * run's tenant, like the connection resolver: `new EffectLedgerRepository(scope)`.)
 */

import { and, eq, isNull, lt } from 'drizzle-orm';

import { toolEffects } from '@/db/schema.js';
import type {
  EffectAcquisition,
  EffectErrorRecord,
  EffectFailureDisposition,
  EffectLedger,
  EffectReservation,
} from '@/domain/effect-ledger.js';
import { DEFAULT_LEASE_MS, EFFECT_SETTLEMENT_MARGIN_MS } from '@/domain/timing.js';
import { TenantScope, TenantScopedRepository } from '@/repositories/tenant-scope.js';

/**
 * How many times `acquire` re-reads and re-branches after losing a CAS race
 * before it gives up and defers. Contention on a single effect key is already
 * rare — the queue lease means one worker per job — and every branch here either
 * resolves or advances the row's state, so a tiny bound is ample. Exceeding it is
 * not an error: we simply defer the job briefly and let it try again cleanly.
 */
const MAX_ACQUIRE_CONTENTION_RETRIES = 3;

/** A short defer used only when `acquire` cannot resolve within the retry bound. */
const CONTENTION_DEFER_MS = 1_000;

export interface EffectLedgerRepositoryOptions {
  /**
   * The clock. Injectable so tests can drive lease-expiry deterministically; in
   * production it is the wall clock. Every lease horizon and expiry comparison is
   * computed from this one source, exactly as the job queue does.
   */
  readonly now?: () => Date;
}

export class EffectLedgerRepository extends TenantScopedRepository implements EffectLedger {
  private readonly now: () => Date;

  constructor(scope: TenantScope, options: EffectLedgerRepositoryOptions = {}) {
    super(scope);
    this.now = options.now ?? (() => new Date());
  }

  async acquire(reservation: EffectReservation): Promise<EffectAcquisition> {
    const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + reservation.leaseMs);

    // (1) Atomic reservation. If this INSERT returns a row, THIS attempt won a
    // fresh reservation and must run the connector. If it conflicts (empty
    // result), an equivalent reservation already exists — fall through to observe
    // it. This is the sole concurrency boundary; there is deliberately no prior
    // SELECT that two attempts could both pass.
    const inserted = await this.db
      .insert(toolEffects)
      .values({
        tenantId: this.tenantId,
        runId: reservation.runId,
        stepKey: reservation.stepKey,
        toolName: reservation.toolName,
        ordinal: reservation.ordinal,
        idempotencyKey: reservation.idempotencyKey,
        provider: reservation.provider,
        state: 'pending',
        owner: reservation.owner,
        leaseExpiresAt,
      })
      .onConflictDoNothing({ target: [toolEffects.tenantId, toolEffects.idempotencyKey] })
      .returning({ id: toolEffects.id });

    if (inserted.length > 0) {
      return { kind: 'acquired' };
    }

    // (2) A reservation already exists. Observe it and branch, re-reading if a CAS
    // transition loses a race to a concurrent attempt.
    for (let attempt = 0; attempt < MAX_ACQUIRE_CONTENTION_RETRIES; attempt += 1) {
      const decision = await this.observeExisting(reservation);
      if (decision !== 'retry') return decision;
    }

    // Persistent contention (should be unreachable given one-worker-per-job): do
    // not touch the row, just defer this job briefly and let it re-acquire clean.
    return { kind: 'defer', retryAfterMs: CONTENTION_DEFER_MS };
  }

  /**
   * Read the existing reservation and decide this attempt's fate, performing the
   * CAS transition its state calls for. Returns `'retry'` when a CAS lost a race
   * and the caller should re-read; otherwise returns the terminal decision.
   */
  private async observeExisting(reservation: EffectReservation): Promise<EffectAcquisition | 'retry'> {
    const now = this.now();

    const [row] = await this.db
      .select({
        state: toolEffects.state,
        owner: toolEffects.owner,
        leaseExpiresAt: toolEffects.leaseExpiresAt,
        result: toolEffects.result,
        error: toolEffects.error,
      })
      .from(toolEffects)
      .where(
        and(
          eq(toolEffects.tenantId, this.tenantId),
          eq(toolEffects.idempotencyKey, reservation.idempotencyKey),
        ),
      )
      .limit(1);

    if (row === undefined) {
      // The conflict said a row exists but it is not readable now. Rows are never
      // deleted except by run cascade, so this is effectively unreachable; defer
      // rather than invent a decision.
      return { kind: 'defer', retryAfterMs: CONTENTION_DEFER_MS };
    }

    // Terminal states: replay or re-throw, never re-run the connector.
    if (row.state === 'succeeded') {
      return { kind: 'replay', result: row.result };
    }
    if (row.state === 'failed') {
      return { kind: 'failed', error: readErrorRecord(row.error) };
    }
    if (row.state === 'ambiguous') {
      return { kind: 'ambiguous', error: readErrorRecord(row.error) };
    }

    // state === 'pending'. Two shapes, discriminated by the owner:
    //   owner IS NULL      → a prior attempt released it as effect-safe → acquire.
    //   owner NOT NULL     → an attempt holds/held it:
    //       lease live     → still working → defer.
    //       lease expired  → crashed holding it → ambiguous.
    if (row.owner === null) {
      // CAS-acquire the safely-released reservation. Guard on owner IS NULL so only
      // one racing attempt wins; the loser re-reads.
      const leaseExpiresAt = new Date(now.getTime() + reservation.leaseMs);
      const acquired = await this.db
        .update(toolEffects)
        .set({ owner: reservation.owner, leaseExpiresAt, error: null })
        .where(
          and(
            eq(toolEffects.tenantId, this.tenantId),
            eq(toolEffects.idempotencyKey, reservation.idempotencyKey),
            eq(toolEffects.state, 'pending'),
            isNull(toolEffects.owner),
          ),
        )
        .returning({ id: toolEffects.id });
      return acquired.length > 0 ? { kind: 'acquired' } : 'retry';
    }

    const leaseLive = row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() > now.getTime();
    if (leaseLive) {
      // Another attempt is actively working this effect. Do NOT touch the row.
      // Defer this job until safely past the live lease horizon: the remaining
      // lease plus the settlement margin, so one deferral lands after the owner has
      // either settled or crashed and let the lease lapse. Capped at the job lease.
      const remainingMs = row.leaseExpiresAt!.getTime() - now.getTime();
      const retryAfterMs = Math.min(remainingMs + EFFECT_SETTLEMENT_MARGIN_MS, DEFAULT_LEASE_MS);
      return { kind: 'defer', retryAfterMs };
    }

    // Owner set but lease expired: the attempt crashed holding the reservation.
    // Indistinguishable from a completed-but-unsettled effect, so the outcome is
    // unknowable. CAS the row to `ambiguous`, guarding that the lease is still
    // expired (a concurrent renewal would move it) so only one attempt settles it.
    const crashError: EffectErrorRecord = {
      code: 'effect_owner_lease_expired',
      message: 'the attempt holding this effect reservation crashed before settling it; outcome is unknown',
      retryable: false,
    };
    const settled = await this.db
      .update(toolEffects)
      .set({ state: 'ambiguous', error: crashError as unknown as Record<string, unknown>, leaseExpiresAt: null })
      .where(
        and(
          eq(toolEffects.tenantId, this.tenantId),
          eq(toolEffects.idempotencyKey, reservation.idempotencyKey),
          eq(toolEffects.state, 'pending'),
          lt(toolEffects.leaseExpiresAt, now),
        ),
      )
      .returning({ id: toolEffects.id });
    return settled.length > 0 ? { kind: 'ambiguous', error: crashError } : 'retry';
  }

  async settleSuccess(reservation: EffectReservation, result: unknown): Promise<void> {
    // CAS pending → succeeded, guarded on THIS attempt still owning the row. If it
    // matches nothing the lease was superseded (another attempt took over); the
    // external effect still happened, and the winning attempt owns the outcome, so
    // there is nothing safe for us to overwrite. Store the normalised result for
    // replay to any later attempt.
    await this.db
      .update(toolEffects)
      .set({ state: 'succeeded', result: result ?? null, leaseExpiresAt: null })
      .where(this.ownedPending(reservation));
  }

  async settleFailure(reservation: EffectReservation, disposition: EffectFailureDisposition): Promise<void> {
    if (disposition.kind === 'release') {
      // Effect-safe retryable failure: the connector guaranteed the write did not
      // happen. Return the reservation to `pending` with owner NULL so the NEXT
      // attempt may genuinely re-execute. Guarded on this attempt still owning it.
      await this.db
        .update(toolEffects)
        .set({ owner: null, leaseExpiresAt: null, error: disposition.error as unknown as Record<string, unknown> })
        .where(this.ownedPending(reservation));
      return;
    }

    // Terminal: `failed` (deterministic) or `ambiguous` (unknown outcome, held).
    const state = disposition.kind === 'permanent' ? 'failed' : 'ambiguous';
    await this.db
      .update(toolEffects)
      .set({ state, error: disposition.error as unknown as Record<string, unknown>, leaseExpiresAt: null })
      .where(this.ownedPending(reservation));
  }

  /** The CAS guard shared by every settlement: this tenant's row, still pending, still ours. */
  private ownedPending(reservation: EffectReservation): ReturnType<typeof and> {
    return and(
      eq(toolEffects.tenantId, this.tenantId),
      eq(toolEffects.idempotencyKey, reservation.idempotencyKey),
      eq(toolEffects.state, 'pending'),
      eq(toolEffects.owner, reservation.owner),
    );
  }
}

/**
 * Reconstruct a stored failure into an {@link EffectErrorRecord}. Defensive about a
 * row whose `error` JSON predates or violates the shape — a stored effect error
 * should always be well-formed, but a replayed re-throw must never itself crash.
 */
function readErrorRecord(error: Record<string, unknown> | null): EffectErrorRecord {
  if (error === null || typeof error !== 'object') {
    return { code: 'effect_error', message: 'the effect failed', retryable: false };
  }
  const code = typeof error['code'] === 'string' ? (error['code'] as string) : 'effect_error';
  const message = typeof error['message'] === 'string' ? (error['message'] as string) : 'the effect failed';
  const retryable = error['retryable'] === true;
  return { code, message, retryable };
}
