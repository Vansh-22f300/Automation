/**
 * The reaper: a periodic sweep that returns jobs abandoned by dead workers to
 * the queue.
 *
 * A worker claims a job under a lease and then — in the normal case — settles
 * it. But a worker can crash, be OOM-killed, or lose its network mid-step,
 * leaving a job stuck `running` with a lease no one will ever renew. The reaper
 * is the safety net: on a timer it asks the queue to requeue every `running`
 * job whose lease has expired, so that work is never lost to a process that
 * vanished.
 *
 * The reaping itself (the atomic, concurrency-safe UPDATE) lives in the queue.
 * This class only owns the schedule, and is separate from the `Worker` on
 * purpose: reaping is cross-worker housekeeping, not part of any one worker's
 * claim loop, and several processes can run it at once without conflict.
 *
 * The net is bounded: a job whose crash-recovery budget is spent is dead-lettered
 * by the queue rather than requeued again, and the reaper logs it once, loudly,
 * with the identifiers needed to find it. That is the whole of the reaper's
 * authority — it settles jobs, never runs.
 */

import { MAX_CRASH_ATTEMPTS } from '@/domain/queue.js';
import type { Logger } from '@/observability/logger.js';
import type { Queue, ReapResult } from '@/domain/queue.js';
import type { WorkerHeartbeat } from '@/worker/heartbeat.js';

export interface ReaperOptions {
  readonly queue: Queue;
  readonly logger: Logger;
  /** How often to sweep for expired leases. */
  readonly intervalMs: number;
  /**
   * Optional in-memory heartbeat tracker. When supplied, the reaper counts
   * every job it recovers (both requeued and dead-lettered) into the same
   * shared counter, so an operator looking at a single snapshot sees the
   * worker process's overall throughput, not just the worker-loop half of
   * it. Omitting it is safe — production wiring in `main.ts` always supplies
   * one.
   */
  readonly heartbeat?: WorkerHeartbeat;
}

export class Reaper {
  private readonly queue: Queue;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly heartbeat: WorkerHeartbeat | undefined;

  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(options: ReaperOptions) {
    this.queue = options.queue;
    this.logger = options.logger;
    this.intervalMs = options.intervalMs;
    this.heartbeat = options.heartbeat;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info({ interval_ms: this.intervalMs }, 'reaper_started');
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.sweep();
    }, this.intervalMs);
  }

  /** Reclaim expired jobs once. Exposed so tests can drive it without a timer. */
  async sweep(): Promise<ReapResult> {
    try {
      const result = await this.queue.requeueExpired();
      if (result.requeued > 0) this.logger.info({ requeued: result.requeued }, 'job_requeued');

      // One line per poison job, at error level: this is the only signal that
      // work was abandoned for good, and it is what an alert should fire on.
      // Identifiers only — no payload, no step output, no credential.
      for (const job of result.deadLettered) {
        this.logger.error(
          {
            tenant_id: job.tenantId,
            run_id: job.runId,
            job_id: job.id,
            step_key: job.stepKey,
            attempt: job.attempt,
            crash_attempt_limit: MAX_CRASH_ATTEMPTS,
          },
          'job_dead_lettered',
        );
      }

      // Count both kinds of recovery under one reaped counter — operators
      // looking at the snapshot want the total jobs the reaper had to mop up,
      // not the requeued-vs-dead-lettered split (which the per-job logs above
      // already make visible).
      this.heartbeat?.recordReaped(result.requeued + result.deadLettered.length);

      return result;
    } catch (error) {
      // Never let a failed sweep kill the process; the next tick tries again.
      this.logger.error({ err: error }, 'reaper_sweep_failed');
      return { requeued: 0, deadLettered: [] };
    } finally {
      this.scheduleNext();
    }
  }
}
