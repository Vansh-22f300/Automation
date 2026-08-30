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
import type { LlmProvider } from '@/domain/llm.js';
import { compileOutputSchema } from '@/domain/output-schema.js';
import type { StepType, WorkflowStep } from '@/domain/workflow-definition.js';
import type { Logger } from '@/observability/logger.js';

/** What a handler is asked to execute: the step's definition and the run context. */
export interface StepExecution {
  readonly step: WorkflowStep;
  readonly context: ExecutionContext;
  /** The resolved input for this step (references already substituted). */
  readonly input: Record<string, unknown> | null;
  /**
   * A step-scoped logger the engine binds with run/step correlation ids. Optional
   * so a handler can be exercised without one; when present, a handler may emit
   * its own structured events (metadata only — never prompts, outputs or secrets).
   */
  readonly logger?: Logger;
}

/** Normalized token/latency accounting a handler may report for persistence. */
export interface StepUsage {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly latencyMs: number;
}

/**
 * The result of executing one step: the output to record and add to the run
 * context, plus optional usage the engine persists (e.g. an `llm` step's token
 * accounting). A step that meters nothing simply omits `usage`.
 */
export interface StepResult {
  readonly output: unknown;
  readonly usage?: StepUsage;
}

/**
 * Executes one step of one run. Returns a `StepResult` on success, or throws to
 * signal failure — a `PermanentError` for a deterministic problem (bad config,
 * unresolved reference, malformed model output), any other error for the
 * unexpected. The engine records the outcome; a handler never touches the database
 * or the queue itself.
 */
export interface StepHandler {
  execute(execution: StepExecution): Promise<StepResult>;
}

/**
 * The `noop` handler: validates nothing beyond what the definition schema already
 * guaranteed and produces a small, deterministic output. It performs no I/O and
 * has no side effects, which is exactly why it is the step type the execution
 * engine is proven against before any real connector exists.
 */
export class NoopStepHandler implements StepHandler {
  execute(_execution: StepExecution): Promise<StepResult> {
    return Promise.resolve({ output: { ok: true } });
  }
}

/**
 * The `llm` handler: the first step type that performs real AI reasoning.
 *
 * It is a thin, deterministic bridge from a validated step definition to the
 * vendor-neutral `LlmProvider`, and it owns exactly one responsibility the
 * provider does not: enforcing the **prompt-injection trust boundary.** The
 * configured `system` instruction (static, developer-authored) becomes the SYSTEM
 * turn; the resolved `input` (which may be untrusted data pulled from a webhook
 * payload or a prior step's output) becomes a USER turn — never the other way
 * round, and never concatenated together. Data is data; it is not promoted to
 * instructions.
 *
 * The handler never imports an SDK, never inspects a provider-specific response,
 * and never touches the database or the queue. It resolves the schema, calls
 * `completeStructured`, and returns normalized output plus usage; the engine
 * persists both. A malformed result surfaces from the provider as a
 * `PermanentError` — this handler does not fall back to parsing free text.
 */
export class LlmStepHandler implements StepHandler {
  constructor(private readonly provider: LlmProvider) {}

  async execute(execution: StepExecution): Promise<StepResult> {
    const { step } = execution;
    if (step.type !== 'llm') {
      // Defensive: the registry routes by type, so this cannot happen in practice.
      throw new PermanentError('llm_wrong_step_type', `LlmStepHandler cannot run a "${step.type}" step`, {
        details: { stepType: step.type },
      });
    }

    const config = step.config;
    // The user content is the *resolved* input (references already substituted by
    // the engine before this handler was called). A missing reference will have
    // failed the step before we got here, so the field is present.
    const resolved = execution.input?.['input'];
    const userContent = typeof resolved === 'string' ? resolved : JSON.stringify(resolved);

    const schema = compileOutputSchema(config.output_schema);
    const model = config.model ?? this.provider.defaultModel;
    const logger = execution.logger;

    logger?.info({ provider: this.provider.name, model }, 'llm_step_started');

    try {
      const completion = await this.provider.completeStructured({
        system: config.system,
        messages: [{ role: 'user', content: userContent }],
        maxOutputTokens: config.max_output_tokens,
        schema,
        ...(config.model !== undefined ? { model: config.model } : {}),
      });

      logger?.info(
        {
          provider: completion.provider,
          model: completion.model,
          latency_ms: completion.latencyMs,
          input_tokens: completion.usage.inputTokens,
          output_tokens: completion.usage.outputTokens,
          total_tokens: completion.usage.totalTokens,
        },
        'llm_step_succeeded',
      );

      return {
        output: completion.data,
        usage: {
          provider: completion.provider,
          model: completion.model,
          inputTokens: completion.usage.inputTokens,
          outputTokens: completion.usage.outputTokens,
          totalTokens: completion.usage.totalTokens,
          latencyMs: completion.latencyMs,
        },
      };
    } catch (error) {
      // Metadata-only failure log; the engine records the structured error too.
      const code = error instanceof PermanentError ? error.code : 'llm_error';
      logger?.warn({ provider: this.provider.name, model, err_code: code }, 'llm_step_failed');
      throw error;
    }
  }
}

/**
 * A stand-in `llm` handler for when no provider is configured. It lets the worker
 * boot without a Claude credential (nothing constructs a provider until an `llm`
 * step actually runs), and fails that step cleanly and deterministically rather
 * than crashing the process.
 */
export class UnconfiguredLlmStepHandler implements StepHandler {
  execute(_execution: StepExecution): Promise<StepResult> {
    return Promise.reject(
      new PermanentError(
        'llm_provider_not_configured',
        'an llm step ran but no LLM provider is configured (set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN)',
      ),
    );
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

/** Options for wiring the production registry. */
export interface DefaultStepHandlerRegistryOptions {
  /**
   * The provider `llm` steps use. When omitted, the `llm` type is still
   * registered — but with a handler that fails cleanly at execution — so the
   * worker boots without a Claude credential and only an actual `llm` step is
   * affected.
   */
  readonly llmProvider?: LlmProvider;
}

/** The registry the worker wires in production: every step type the MVP supports. */
export function defaultStepHandlerRegistry(
  options: DefaultStepHandlerRegistryOptions = {},
): StepHandlerRegistry {
  const llmHandler: StepHandler =
    options.llmProvider !== undefined
      ? new LlmStepHandler(options.llmProvider)
      : new UnconfiguredLlmStepHandler();
  return new StepHandlerRegistry().register('noop', new NoopStepHandler()).register('llm', llmHandler);
}
