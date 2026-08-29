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
 */

import type { Logger } from '@/observability/logger.js';
import type { Queue } from '@/domain/queue.js';

export interface ReaperOptions {
  readonly queue: Queue;
  readonly logger: Logger;
  /** How often to sweep for expired leases. */
  readonly intervalMs: number;
}

export class Reaper {
  private readonly queue: Queue;
  private readonly logger: Logger;
  private readonly intervalMs: number;

  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(options: ReaperOptions) {
    this.queue = options.queue;
    this.logger = options.logger;
    this.intervalMs = options.intervalMs;
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
  async sweep(): Promise<number> {
    try {
      const requeued = await this.queue.requeueExpired();
      if (requeued > 0) this.logger.info({ requeued }, 'job_requeued');
      return requeued;
    } catch (error) {
      // Never let a failed sweep kill the process; the next tick tries again.
      this.logger.error({ err: error }, 'reaper_sweep_failed');
      return 0;
    } finally {
      this.scheduleNext();
    }
  }
}
