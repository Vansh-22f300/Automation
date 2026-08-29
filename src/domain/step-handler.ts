/**
 * Step handlers: the seam between the engine's uniform "advance one step"
 * machinery and the behaviour of a specific step type.
 *
 * The engine knows how to load a run, resolve input, write a `workflow_step_runs`
 * row, persist output and enqueue the next job — none of which depends on *what*
 * a step does. A `StepHandler` supplies exactly that missing piece: given the
 * run's context and the step's validated definition, produce an output (or throw).
 * The worker and the engine never branch on step type; the registry resolves
 * type → handler, so adding `llm`/`action` later is a new handler plus one
 * `register` call, not a change to the executor.
 *
 * Only `noop` exists today, and its handler is intentionally trivial.
 */

import { PermanentError } from '@/domain/errors.js';
import type { ExecutionContext } from '@/domain/execution-context.js';
import type { StepType, WorkflowStep } from '@/domain/workflow-definition.js';

/** What a handler is asked to execute: the step's definition and the run context. */
export interface StepExecution {
  readonly step: WorkflowStep;
  readonly context: ExecutionContext;
  /** The resolved input for this step (references already substituted). */
  readonly input: Record<string, unknown> | null;
}

/**
 * Executes one step of one run. Returns the step's output on success, or throws
 * to signal failure — a `PermanentError` for a deterministic problem (bad config,
 * unresolved reference), any other error for the unexpected. The engine records
 * the outcome; a handler never touches the database or the queue itself.
 */
export interface StepHandler {
  execute(execution: StepExecution): Promise<unknown>;
}

/**
 * The `noop` handler: validates nothing beyond what the definition schema already
 * guaranteed and produces a small, deterministic output. It performs no I/O and
 * has no side effects, which is exactly why it is the step type the execution
 * engine is proven against before any real connector exists.
 */
export class NoopStepHandler implements StepHandler {
  execute(_execution: StepExecution): Promise<unknown> {
    return Promise.resolve({ ok: true });
  }
}

/**
 * Resolves a step type to its handler. Constructed once and shared; unknown types
 * fail loudly (a definition should never have passed validation with a type the
 * engine cannot run, so this is a "should be impossible" guard, not a user error
 * path — but it fails cleanly rather than dispatching `undefined`).
 */
export class StepHandlerRegistry {
  private readonly handlers = new Map<StepType, StepHandler>();

  register(type: StepType, handler: StepHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  get(type: StepType): StepHandler {
    const handler = this.handlers.get(type);
    if (handler === undefined) {
      throw new PermanentError('unknown_step_type', `no handler registered for step type "${type}"`, {
        details: { stepType: type },
      });
    }
    return handler;
  }
}

/** The registry the worker wires in production: every step type the MVP supports. */
export function defaultStepHandlerRegistry(): StepHandlerRegistry {
  return new StepHandlerRegistry().register('noop', new NoopStepHandler());
}
