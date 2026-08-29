/**
 * The execution context: a run's accumulated state, as the engine and step
 * handlers are allowed to see it.
 *
 * A run carries a small state document (`workflow_runs.context`): the trigger it
 * was born from, and the output of every step that has run so far. This class is
 * the *only* sanctioned way to read and mutate that document during execution, so
 * handlers never touch raw JSON and the engine has one place to snapshot back to
 * the database.
 *
 * It is deliberately tiny — three operations — and framework-free. There is no
 * expression language here, no memory, no embeddings; just "what triggered this"
 * and "what did step X produce". Reference resolution (`{{trigger.payload}}`,
 * `{{steps.first.output}}`) lives in `@/domain/references` and reads *through*
 * this context; it is not baked in.
 */

import type { RunContext, TriggerContext } from '@/domain/workflow-run.js';

/** A single step's recorded result within the context. */
export interface StepResultRecord {
  readonly output: unknown;
}

/**
 * A mutable view over a run's context for the duration of one step execution.
 *
 * Constructed from the context as stored, it copies the `steps` map so mutations
 * do not alias the caller's object; `snapshot()` produces the value to persist
 * back to `workflow_runs.context`.
 */
export class ExecutionContext {
  private readonly trigger: TriggerContext;
  private readonly steps: Record<string, StepResultRecord>;

  constructor(context: RunContext) {
    this.trigger = context.trigger;
    // Copy so setStepOutput never mutates the stored object in place; each step
    // records against a fresh map the engine then snapshots.
    this.steps = {};
    for (const [key, value] of Object.entries(context.steps ?? {})) {
      this.steps[key] = value as StepResultRecord;
    }
  }

  /** The trigger facts this run was born knowing. */
  getTrigger(): TriggerContext {
    return this.trigger;
  }

  /**
   * The recorded output of a prior step, or `undefined` if that step has not run
   * (or does not exist). Callers that require the step decide what absence means.
   */
  getStepOutput(stepKey: string): unknown {
    return this.steps[stepKey]?.output;
  }

  /** True if a step has recorded a result in this context. */
  hasStep(stepKey: string): boolean {
    return this.steps[stepKey] !== undefined;
  }

  /** Record a step's output. Overwrites any prior record for that key. */
  setStepOutput(stepKey: string, output: unknown): void {
    this.steps[stepKey] = { output };
  }

  /** The full context document to persist back to `workflow_runs.context`. */
  snapshot(): RunContext {
    return { trigger: this.trigger, steps: { ...this.steps } };
  }
}
