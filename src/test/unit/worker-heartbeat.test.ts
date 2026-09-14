/**
 * Unit tests for `WorkerHeartbeat`.
 *
 * The class is pure in-memory state, so the tests drive it deterministically
 * by passing explicit `now` / `nowMonotonicMs` values to every method that
 * accepts them. No fake timers, no `vi.useFakeTimers`, no perf_hooks patch:
 * the API contract is "callers supply the wall clock and the monotonic clock",
 * and the tests hold them to it.
 */

import { describe, expect, it } from "vitest";

import {
  POLL_INTERVAL_MS,
  REAPER_INTERVAL_MS,
  STALE_HEARTBEAT_MS,
  WorkerHeartbeat,
} from "@/worker/heartbeat.js";

/** Build an ISO timestamp from a wall-clock number of ms since the epoch. */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Convenience: pick a deterministic wall-clock and monotonic pair. */
const T0_WALL = Date.parse("2026-01-01T00:00:00.000Z");
const T0_MONO = 1_000;

describe("WorkerHeartbeat — lifecycle transitions", () => {
  it("starts in 'never_started' with all timestamps null and zero counts", () => {
    const hb = new WorkerHeartbeat();
    const snap = hb.snapshot(new Date(T0_WALL), T0_MONO);
    expect(snap.state).toBe("never_started");
    expect(snap.startedAt).toBeNull();
    expect(snap.uptimeSeconds).toBeNull();
    expect(snap.lastTickAt).toBeNull();
    expect(snap.lastTickAgeMs).toBeNull();
    expect(snap.isStale).toBe(false);
    expect(snap.inFlight).toBe(0);
    expect(snap.counts).toEqual({
      claimed: 0,
      completed: 0,
      failed: 0,
      released: 0,
      reaped: 0,
    });
  });

  it("start() promotes to 'starting' and stamps startedAt", () => {
    const hb = new WorkerHeartbeat();
    hb.start(new Date(T0_WALL));
    const snap = hb.snapshot(new Date(T0_WALL), T0_MONO);
    expect(snap.state).toBe("starting");
    expect(snap.startedAt).toBe(iso(T0_WALL));
    expect(snap.uptimeSeconds).toBe(0);
  });

  it("start() is idempotent — a second call does not reset startedAt", () => {
    const hb = new WorkerHeartbeat();
    hb.start(new Date(T0_WALL));
    const later = T0_WALL + 5_000;
    hb.start(new Date(later));
    expect(hb.snapshot(new Date(later), T0_MONO + 5_000).startedAt).toBe(iso(T0_WALL));
  });

  it("tick() after start() promotes to 'running' and stamps lastTickAt", () => {
    const hb = new WorkerHeartbeat();
    hb.start(new Date(T0_WALL));
    hb.tick(new Date(T0_WALL + 1_000), T0_MONO + 1_000);
    const snap = hb.snapshot(new Date(T0_WALL + 1_000), T0_MONO + 1_000);
    expect(snap.state).toBe("running");
    expect(snap.lastTickAt).toBe(iso(T0_WALL + 1_000));
    expect(snap.lastTickAgeMs).toBe(0);
  });

  it("tick() without start() promotes 'never_started' to 'running' in one step", () => {
    // A worker that races tick() and start() should still produce a coherent
    // snapshot. The tick() method handles this for callers that want to skip
    // the explicit start() (tests, in particular).
    const hb = new WorkerHeartbeat();
    hb.tick(new Date(T0_WALL), T0_MONO);
    const snap = hb.snapshot(new Date(T0_WALL), T0_MONO);
    expect(snap.state).toBe("running");
    expect(snap.startedAt).toBe(iso(T0_WALL));
  });

  it("markStopping() / markStopped() walk to terminal", () => {
    const hb = new WorkerHeartbeat();
    hb.start(new Date(T0_WALL));
    hb.tick(new Date(T0_WALL + 100), T0_MONO + 100);
    hb.markStopping();
    expect(hb.snapshot(new Date(T0_WALL + 200), T0_MONO + 200).state).toBe("stopping");
    hb.markStopped();
    expect(hb.snapshot(new Date(T0_WALL + 300), T0_MONO + 300).state).toBe("stopped");
  });

  it("markStopping() is idempotent when already stopped", () => {
    const hb = new WorkerHeartbeat();
    hb.start();
    hb.markStopped();
    hb.markStopping();
    expect(hb.snapshot().state).toBe("stopped");
  });
});

describe("WorkerHeartbeat — counters and in-flight slot", () => {
  it("recordClaimed bumps claimed and sets in-flight", () => {
    const hb = new WorkerHeartbeat();
    hb.start();
    hb.tick();
    hb.recordClaimed();
    const snap = hb.snapshot();
    expect(snap.counts.claimed).toBe(1);
    expect(snap.inFlight).toBe(1);
  });

  it("each terminal count clears the in-flight slot and increments its own counter", () => {
    const hb = new WorkerHeartbeat();

    hb.recordClaimed();
    hb.recordCompleted();
    expect(hb.snapshot().counts.completed).toBe(1);
    expect(hb.snapshot().inFlight).toBe(0);

    hb.recordClaimed();
    hb.recordFailed();
    expect(hb.snapshot().counts.failed).toBe(1);
    expect(hb.snapshot().inFlight).toBe(0);

    hb.recordClaimed();
    hb.recordReleased();
    expect(hb.snapshot().counts.released).toBe(1);
    expect(hb.snapshot().inFlight).toBe(0);
  });

  it("recordReaped ignores zero / negative counts", () => {
    const hb = new WorkerHeartbeat();
    hb.recordReaped(0);
    hb.recordReaped(-3);
    expect(hb.snapshot().counts.reaped).toBe(0);
  });

  it("recordReaped accumulates over multiple sweeps", () => {
    const hb = new WorkerHeartbeat();
    hb.recordReaped(2);
    hb.recordReaped(3);
    hb.recordReaped(5);
    expect(hb.snapshot().counts.reaped).toBe(10);
  });

  it("snapshot copies the counters — a caller cannot mutate the tracker", () => {
    const hb = new WorkerHeartbeat();
    hb.recordClaimed();
    const snap = hb.snapshot();
    // Type-only mutation attempt: cast through unknown to satisfy the type checker.
    (snap.counts as unknown as { claimed: number }).claimed = 999;
    expect(hb.snapshot().counts.claimed).toBe(1);
  });
});

describe("WorkerHeartbeat — stale semantics", () => {
  it("isStale() is false before the first tick", () => {
    const hb = new WorkerHeartbeat();
    hb.start(new Date(T0_WALL));
    expect(hb.isStale(T0_MONO + 10 * 60_000)).toBe(false);
  });

  it("isStale() is false within the threshold", () => {
    const hb = new WorkerHeartbeat();
    hb.tick(new Date(T0_WALL), T0_MONO);
    expect(hb.isStale(T0_MONO + STALE_HEARTBEAT_MS - 1)).toBe(false);
  });

  it("isStale() flips true past the threshold", () => {
    const hb = new WorkerHeartbeat();
    hb.tick(new Date(T0_WALL), T0_MONO);
    expect(hb.isStale(T0_MONO + STALE_HEARTBEAT_MS + 1)).toBe(true);
  });

  it("snapshot.isStale agrees with isStale() at the same moment", () => {
    const hb = new WorkerHeartbeat();
    hb.tick(new Date(T0_WALL), T0_MONO);
    const nowMonotonic = T0_MONO + STALE_HEARTBEAT_MS + 1;
    expect(hb.isStale(nowMonotonic)).toBe(true);
    expect(hb.snapshot(new Date(T0_WALL + STALE_HEARTBEAT_MS + 1), nowMonotonic).isStale).toBe(true);
  });

  it("a fresh tick after a stale window clears the flag", () => {
    const hb = new WorkerHeartbeat();
    hb.tick(new Date(T0_WALL), T0_MONO);
    expect(hb.isStale(T0_MONO + STALE_HEARTBEAT_MS + 1)).toBe(true);
    hb.tick(new Date(T0_WALL + STALE_HEARTBEAT_MS + 1), T0_MONO + STALE_HEARTBEAT_MS + 1);
    expect(hb.isStale(T0_MONO + STALE_HEARTBEAT_MS + 2)).toBe(false);
  });
});

describe("WorkerHeartbeat — stale threshold derivation", () => {
  it("equals max(3 * POLL_INTERVAL_MS, REAPER_INTERVAL_MS) and is derived from existing timing", () => {
    // The whole point: no arbitrary knob. The threshold is a function of
    // the worker-config timing the project already ships with.
    expect(STALE_HEARTBEAT_MS).toBe(Math.max(3 * POLL_INTERVAL_MS, REAPER_INTERVAL_MS));
    expect(POLL_INTERVAL_MS).toBe(1_000);
    expect(REAPER_INTERVAL_MS).toBe(30_000);
    expect(STALE_HEARTBEAT_MS).toBe(30_000);
  });
});

describe("WorkerHeartbeat — redaction-free snapshot", () => {
  it("never includes tenant, run, job, step, payload, secret, or error fields", () => {
    const hb = new WorkerHeartbeat();
    hb.start();
    hb.tick();
    hb.recordClaimed();
    hb.recordCompleted();
    const snap = hb.snapshot();
    // Round-trip through JSON.stringify to catch any accidental object
    // reference that would surface an opaque blob in a real log sink.
    // Use word boundaries so values like `"running"` (state field) do not
    // false-positive on the substring `run`.
    const json = JSON.stringify(snap);
    expect(json).not.toMatch(/\btenant\b/);
    expect(json).not.toMatch(/\brun\b/);
    expect(json).not.toMatch(/\bjob\b/);
    expect(json).not.toMatch(/\bstep\b/);
    expect(json).not.toMatch(/\bpayload\b/);
    expect(json).not.toMatch(/\bsecret\b/);
    expect(json).not.toMatch(/\bcredential\b/);
    expect(json).not.toMatch(/\berror\b/i);
    expect(json).not.toMatch(/\bError\b/);
  });
});

describe("WorkerHeartbeat — slow-step stale semantics", () => {
  it("reports isStale=true while lifecycle stays running and inFlight stays 1 (isStale is NOT death)", () => {
    // The semantic distinction documented in the heartbeat.ts docstring's
    // caveat, made explicit here so a future refactor cannot drift the
    // behaviour without breaking this test:
    //
    //   - isStale indicates lack of recent poll-loop heartbeat (driven by
    //     the monotonic clock); it does NOT by itself prove the worker is
    //     dead.
    //   - state and inFlight are the truthful signals during a legitimately
    //     long-running step that exceeds the threshold.
    //   - Worker.tick() stamps at the start of each poll iteration; the
    //     actual step (pollOnce → handle → dispatch) can legitimately take
    //     longer than STALE_HEARTBEAT_MS without re-stamping until the next
    //     tick is scheduled after it resolves.
    //
    // Driving the heartbeat class directly with explicit time values is the
    // way to express this without sleeping for 30+ seconds.
    const hb = new WorkerHeartbeat();
    // start() + tick() + recordClaimed() — a worker that is "running"
    // holding an in-flight job.
    hb.start(new Date(T0_WALL));
    hb.tick(new Date(T0_WALL), T0_MONO);
    hb.recordClaimed();
    expect(hb.snapshot().state).toBe("running");
    expect(hb.snapshot().inFlight).toBe(1);
    expect(hb.snapshot().isStale).toBe(false);

    // Simulate the step still in flight: the monotonic clock advances past
    // the stale threshold, but no new tick has happened. The heartbeat is
    // honest about each axis: the snapshot reports isStale=true WHILE state
    // stays running and inFlight stays 1. An operator that concludes "dead"
    // from isStale alone is wrong in this window.
    const wallAfter = T0_WALL + STALE_HEARTBEAT_MS + 1;
    const monotonicAfter = T0_MONO + STALE_HEARTBEAT_MS + 1;
    const mid = hb.snapshot(new Date(wallAfter), monotonicAfter);
    expect(mid.state).toBe("running");
    expect(mid.inFlight).toBe(1);
    expect(mid.isStale).toBe(true);

    // A fresh tick after the long step (e.g. scheduleNext chained at delay 0
    // after the step completes) re-arms the stale flag — but state and
    // inFlight are unchanged because no settlement record has been called.
    hb.tick(new Date(wallAfter), monotonicAfter);
    const recovered = hb.snapshot(
      new Date(wallAfter + 1),
      monotonicAfter + 1,
    );
    expect(recovered.state).toBe("running");
    expect(recovered.inFlight).toBe(1);
    expect(recovered.isStale).toBe(false);

    // Sanity: a worker that has actually been stopped looks unmistakably
    // different from a worker that is merely mid-long-step — state carries
    // the truth where isStale does not.
    hb.markStopping();
    hb.markStopped();
    const stopped = hb.snapshot(
      new Date(wallAfter + 2),
      monotonicAfter + 2,
    );
    expect(stopped.state).toBe("stopped");
    // isStale is allowed to be true here — a stopped worker is also "not
    // freshly ticking" — but the distinction operators rely on is state,
    // not isStale.
    expect(["running", "stopping", "stopped"]).not.toContain(""); // tautology, just to anchor state check above
    expect(stopped.state).not.toBe("running");
  });
});
