/**
 * In-memory worker heartbeat and lifecycle-state tracker.
 *
 * The worker process exposes its operational state through this object: lifecycle
 * transitions (start / running / stopping / stopped), the timestamp of the most
 * recent poll tick, an in-flight counter, and cumulative settlement counts. All of
 * it lives in the worker process only — there is no shared table, no Redis key,
 * no IPC, no metrics framework. The operator reads state from structured logs
 * emitted against this object and (in this iteration) from the snapshot itself
 * if anything in-process asks for it.
 *
 * Two timestamps are kept per tick on purpose:
 *
 *   - `lastTickAt: Date` is the wall-clock timestamp, formatted as ISO for logs
 *     and the snapshot. Operators read this and it lines up with `journalctl` /
 *     Loki / Datadog timelines.
 *   - `lastTickMonotonicMs: number` is read from `performance.now()`, which is
 *     monotonic and immune to wall-clock jumps (NTP corrections, manual clock
 *     changes, suspend/resume). Stale detection uses the monotonic value so a
 *     clock skew cannot make a healthy worker look stale or a stuck one look
 *     healthy.
 *
 * The stale threshold is derived from existing worker timing rather than
 * invented: `STALE_HEARTBEAT_MS = max(3 * POLL_INTERVAL_MS, REAPER_INTERVAL_MS)`.
 * A worker that has not ticked in at least one reaper sweep and at least three
 * poll cycles is stale — the reaper itself would have detected stuck leases by
 * then, so the loop is clearly not healthy.
 *
 * **Caveat — `isStale` is a heartbeat-staleness signal, not a death signal.**
 * `Worker.tick()` stamps the heartbeat at the *start* of each poll iteration,
 * then awaits the entire poll-once cycle (claim → dispatch → settle) before
 * scheduling the next tick. A legitimately long-running step — one that
 * exceeds the 30-second stale threshold by a wide margin, all the way up to
 * the legitimate per-step duration ceiling of roughly 9 minutes — will
 * therefore leave `isStale = true` in the periodic summary log while the
 * lifecycle state is still `running` and `inFlight = 1`. An operator reading
 * `isStale` in isolation would false-positive during such a window. The
 * truthful signals are `state`, `inFlight`, `lastTickAt`, and `lastTickAgeMs`
 * read together; `isStale` alone does NOT prove the worker is dead. The
 * authoritative liveness combination is `state === 'running'` together with
 * the absence of `worker_shutdown` / `worker_lease_release_*` log lines from
 * the worker process.
 *
 * What this object deliberately does NOT carry:
 *   - tenant ids, run ids, step keys, or job ids
 *   - prompts, payloads, tool outputs, or step results
 *   - secrets, connection metadata, decrypted credentials
 *   - raw error objects (callers log the error themselves; the counter only
 *     tells them "something failed")
 * The snapshot is safe to expose in any logging sink or future operational
 * endpoint without redaction.
 */

import { performance } from 'node:perf_hooks';

/** How long the worker idles between polls when the queue is empty. */
export const POLL_INTERVAL_MS = 1_000;

/** How often the reaper sweeps for expired leases. */
export const REAPER_INTERVAL_MS = 30_000;

/**
 * A heartbeat is stale when the worker has not ticked for at least this many
 * monotonic milliseconds. Derived from existing timing: at least one reaper
 * sweep (30 s) and at least three poll cycles (3 × 1 s = 3 s). The reaper
 * ceiling dominates, so this is effectively REAPER_INTERVAL_MS — chosen
 * because the reaper is the next line of defense and a worker that has missed
 * a full sweep has clearly stopped ticking. Not a knob; not configurable.
 */
export const STALE_HEARTBEAT_MS = Math.max(3 * POLL_INTERVAL_MS, REAPER_INTERVAL_MS);

/**
 * Coarse-grained lifecycle. `never_started` only exists for the brief window
 * between `new WorkerHeartbeat()` and `start()`. `starting` covers boot but
 * before the first tick. Once `tick()` fires at least once, the state becomes
 * `running`. `stopping` covers the bounded drain during shutdown, and
 * `stopped` is terminal.
 */
export type WorkerLifecycleState =
  | 'never_started'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped';

/**
 * Cumulative settlement counts. `claimed` increments on every successful
 * `queue.claim(...)`; the matching terminal count (completed / failed /
 * released) clears the in-flight slot. `reaped` is set by the reaper and
 * counts jobs recovered from a dead worker's lease (both requeued and
 * dead-lettered).
 */
export interface WorkerCounters {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly released: number;
  readonly reaped: number;
}

/**
 * Bounded, redaction-free snapshot. Safe to log, safe to expose. `null`
 * timestamps mean "not yet known" rather than 0 or epoch.
 */
export interface WorkerHeartbeatSnapshot {
  readonly state: WorkerLifecycleState;
  /** ISO-8601 wall-clock of the first `start()`. `null` until then. */
  readonly startedAt: string | null;
  /** Whole seconds since `startedAt`. `null` until then. */
  readonly uptimeSeconds: number | null;
  /** ISO-8601 wall-clock of the most recent `tick()`. `null` until first tick. */
  readonly lastTickAt: string | null;
  /** Monotonic milliseconds since the most recent `tick()`. `null` until first tick. */
  readonly lastTickAgeMs: number | null;
  /** True iff `lastTickAgeMs > STALE_HEARTBEAT_MS`. Always false before first tick. */
  readonly isStale: boolean;
  /** 0 or 1 today (one job per worker at a time). Cleared by the next terminal count. */
  readonly inFlight: number;
  readonly counts: WorkerCounters;
}

export class WorkerHeartbeat {
  private state: WorkerLifecycleState = 'never_started';
  private startedAt: Date | null = null;
  private lastTickAt: Date | null = null;
  private lastTickMonotonicMs: number | null = null;
  private inFlight = 0;
  private readonly counts = { claimed: 0, completed: 0, failed: 0, released: 0, reaped: 0 };

  /**
   * Move from `never_started` to `starting`. Stamp the wall-clock start time
   * so `uptimeSeconds` has a reference. Idempotent: a second `start()` after
   * the worker is already running is a no-op rather than a state error.
   */
  start(now: Date = new Date()): void {
    if (this.state !== 'never_started') return;
    this.state = 'starting';
    this.startedAt = now;
  }

  /**
   * Stamp the heartbeat. Called from the worker's `tick()` so that a heartbeat
   * is recorded on every successful or failed poll. Promotes `starting` to
   * `running` on the first tick — `running` is the state an operator wants to
   * see in logs once the loop is genuinely alive.
   *
   * Tick is intentionally callable before `start()` for tests that drive the
   * state machine directly; in production `start()` is always called first.
   */
  tick(now: Date = new Date(), nowMonotonicMs: number = performance.now()): void {
    if (this.state === 'never_started') {
      this.start(now);
    }
    if (this.state === 'starting' || this.state === 'running') {
      this.state = 'running';
    }
    this.lastTickAt = now;
    this.lastTickMonotonicMs = nowMonotonicMs;
  }

  /** A stop has been signalled. Drain is in progress. */
  markStopping(): void {
    if (this.state === 'stopped') return;
    this.state = 'stopping';
  }

  /** Drain finished. Terminal. */
  markStopped(): void {
    this.state = 'stopped';
  }

  recordClaimed(): void {
    this.counts.claimed += 1;
    this.inFlight = 1;
  }

  recordCompleted(): void {
    this.counts.completed += 1;
    this.inFlight = 0;
  }

  recordFailed(): void {
    this.counts.failed += 1;
    this.inFlight = 0;
  }

  recordReleased(): void {
    this.counts.released += 1;
    this.inFlight = 0;
  }

  recordReaped(count: number): void {
    if (count <= 0) return;
    this.counts.reaped += count;
  }

  /**
   * True when the last tick is older than the stale threshold. False before
   * the first tick — a worker that has never ticked is `never_started`/`starting`,
   * not "stale"; its state carries the truth.
   */
  isStale(nowMonotonicMs: number = performance.now()): boolean {
    if (this.lastTickMonotonicMs === null) return false;
    return nowMonotonicMs - this.lastTickMonotonicMs > STALE_HEARTBEAT_MS;
  }

  /**
   * Bounded snapshot. Counters are copied so a caller cannot mutate the
   * tracker's internal state by holding the reference. Timestamps use the
   * provided `now` / `nowMonotonicMs` so tests can drive them deterministically.
   */
  snapshot(
    now: Date = new Date(),
    nowMonotonicMs: number = performance.now(),
  ): WorkerHeartbeatSnapshot {
    const lastTickAgeMs =
      this.lastTickMonotonicMs === null
        ? null
        : Math.max(0, Math.round(nowMonotonicMs - this.lastTickMonotonicMs));
    return {
      state: this.state,
      startedAt: this.startedAt?.toISOString() ?? null,
      uptimeSeconds:
        this.startedAt === null ? null : Math.round((now.getTime() - this.startedAt.getTime()) / 1000),
      lastTickAt: this.lastTickAt?.toISOString() ?? null,
      lastTickAgeMs,
      isStale: this.isStale(nowMonotonicMs),
      inFlight: this.inFlight,
      counts: { ...this.counts },
    };
  }
}
