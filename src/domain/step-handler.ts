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

import { PermanentError, RetryableError } from '@/domain/errors.js';
import type { ConnectionRef, ConnectionResolver } from '@/domain/connection.js';
import type { EffectLedger } from '@/domain/effect-ledger.js';
import type { ExecutionContext } from '@/domain/execution-context.js';
import type {
  LlmProvider,
  LlmToolCall,
  LlmToolDefinition,
  LlmToolMessage,
  LlmToolResult,
  LlmToolTurn,
} from '@/domain/llm.js';
import { compileOutputSchema } from '@/domain/output-schema.js';
import { DEFAULT_EFFECT_LEASE_MS } from '@/domain/timing.js';
import { ToolExecutor } from '@/domain/tool-executor.js';
import type { ToolRegistry } from '@/domain/tool-registry.js';
import type { LlmStepConfig, StepType, WorkflowStep } from '@/domain/workflow-definition.js';
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
  /**
   * Correlation/scoping ids the engine knows. Optional so `noop` and existing
   * handler tests need not supply them; the `llm` handler requires `tenantId`
   * ONLY when the step declares tools (a tenant-scoped resolver is needed to
   * decrypt the trusted connection).
   */
  readonly tenantId?: string;
  readonly runId?: string;
  readonly stepRunId?: string;
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
 * accounting). Usage is an ARRAY: an `llm` step with tools makes several provider
 * calls (one per round), each metered separately. A step that meters nothing
 * simply omits `usage`; the no-tools `llm` path returns a one-element array.
 */
export interface StepResult {
  readonly output: unknown;
  readonly usage?: readonly StepUsage[];
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
/**
 * Optional tool dependencies for the `llm` handler. Present in production (wired
 * from the worker), absent in the no-tools tests. When a step declares `tools`
 * but these are absent, the step fails cleanly with `llm_tools_not_configured`.
 */
export interface LlmToolDeps {
  /** The catalogue of platform-registered tools — the source of truth for names. */
  readonly toolRegistry?: ToolRegistry;
  /** Builds a tenant-scoped connection resolver for the run's tenant. */
  readonly resolverFactory?: (tenantId: string) => ConnectionResolver;
  /**
   * Builds a tenant-scoped effect ledger for the run's tenant. Optional: when
   * absent, tool calls run directly (the pre-ledger behaviour) — external effects
   * are then plain at-least-once with no reservation. When present, every tool
   * call the handler makes is reserved and made retry-safe.
   */
  readonly effectLedgerFactory?: (tenantId: string) => EffectLedger;
}

export class LlmStepHandler implements StepHandler {
  private readonly toolRegistry: ToolRegistry | undefined;
  private readonly resolverFactory: ((tenantId: string) => ConnectionResolver) | undefined;
  private readonly effectLedgerFactory: ((tenantId: string) => EffectLedger) | undefined;

  constructor(
    private readonly provider: LlmProvider,
    deps: LlmToolDeps = {},
  ) {
    this.toolRegistry = deps.toolRegistry;
    this.resolverFactory = deps.resolverFactory;
    this.effectLedgerFactory = deps.effectLedgerFactory;
  }

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

    // Tools declared → the bounded tool-calling loop. Otherwise the original,
    // simpler structured-completion path (unchanged behaviour, single call).
    if (config.tools !== undefined && config.tools.length > 0) {
      return this.executeWithTools({ execution, config, userContent, schema, model });
    }

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
        usage: [
          {
            provider: completion.provider,
            model: completion.model,
            inputTokens: completion.usage.inputTokens,
            outputTokens: completion.usage.outputTokens,
            totalTokens: completion.usage.totalTokens,
            latencyMs: completion.latencyMs,
          },
        ],
      };
    } catch (error) {
      // Metadata-only failure log; the engine records the structured error too.
      const code = error instanceof PermanentError ? error.code : 'llm_error';
      logger?.warn({ provider: this.provider.name, model, err_code: code }, 'llm_step_failed');
      throw error;
    }
  }

  /**
   * The bounded tool-calling path. It offers the model ONLY the model-facing view of
   * each declared tool — `{name, description, inputSchema}` — and holds the trusted
   * `connection_id` binding entirely on the platform side, keyed by tool name. When
   * the model requests a tool, the handler executes it through the {@link ToolExecutor}
   * (which enforces the full security order), passing the trusted `connectionRef` as a
   * separate argument the model never sees. Only the connector's normalized, non-secret
   * output — or a safe `{code, message}` — is fed back to the model. The loop is bounded
   * by `max_tool_rounds`; each provider round is metered as its own usage row.
   */
  private async executeWithTools(params: {
    execution: StepExecution;
    config: LlmStepConfig;
    userContent: string;
    schema: ReturnType<typeof compileOutputSchema>;
    model: string;
  }): Promise<StepResult> {
    const { execution, config, userContent, schema, model } = params;
    const logger = execution.logger;

    // Tool wiring must be present, and a tenant is required to build the
    // tenant-scoped connection resolver. Absent → the step fails cleanly.
    if (this.toolRegistry === undefined || this.resolverFactory === undefined) {
      throw new PermanentError(
        'llm_tools_not_configured',
        'llm step declares tools but the handler has no tool registry / connection resolver configured',
      );
    }
    const tenantId = execution.tenantId;
    if (tenantId === undefined) {
      throw new PermanentError(
        'llm_tools_not_configured',
        'llm step declares tools but no tenantId was supplied to resolve connections',
      );
    }

    const registry = this.toolRegistry;
    const resolver = this.resolverFactory(tenantId);
    // The effect ledger is optional wiring: with it, every tool call this step
    // makes is reserved and made retry-safe; without it the executor calls the
    // connector directly, exactly as before the ledger existed.
    const effectLedger = this.effectLedgerFactory?.(tenantId);
    const toolExecutor = new ToolExecutor(registry, resolver, effectLedger);

    // Two maps, built once. `toolDefs` is the ONLY thing the model sees. `refByName`
    // holds the trusted connection binding; its provider is sourced from the REGISTRY
    // (never from config), and `connection_id` comes from the trusted step config —
    // never from a model argument. An unknown tool name fails here (unknown_tool).
    const toolDefs: LlmToolDefinition[] = [];
    const refByName = new Map<string, ConnectionRef>();
    for (const binding of config.tools ?? []) {
      const tool = registry.resolve(binding.name);
      toolDefs.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
      refByName.set(tool.name, { provider: tool.provider, connectionId: binding.connection_id });
    }

    const usage: StepUsage[] = [];
    const messages: LlmToolMessage[] = [{ role: 'user', content: userContent }];
    const maxRounds = config.max_tool_rounds;

    logger?.info(
      { provider: this.provider.name, model, tool_count: toolDefs.length, max_tool_rounds: maxRounds },
      'llm_step_started',
    );
    // A per-step monotonic counter over EVERY tool call across all rounds. It is the
    // final component of each effect's idempotency key, so a given call reserves the
    // same ledger row on every re-execution of the step while two distinct calls never
    // collide. It advances once per call issued, before the call runs.
    let ordinal = 0;
    // TOOL_LOOP_PLACEHOLDER
    for (let round = 1; round <= maxRounds; round += 1) {
      let turn: LlmToolTurn;
      try {
        turn = await this.provider.converse({
          system: config.system,
          messages,
          tools: toolDefs,
          schema,
          maxOutputTokens: config.max_output_tokens,
          ...(config.model !== undefined ? { model: config.model } : {}),
        });
      } catch (error) {
        const code = error instanceof PermanentError ? error.code : 'llm_error';
        logger?.warn({ provider: this.provider.name, model, round, err_code: code }, 'llm_step_failed');
        throw error;
      }

      // Meter every round, whether it asked for tools or produced the final answer.
      usage.push({
        provider: turn.provider,
        model: turn.model,
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
        totalTokens: turn.usage.totalTokens,
        latencyMs: turn.latencyMs,
      });

      if (turn.kind === 'final') {
        logger?.info(
          { provider: turn.provider, model: turn.model, rounds: round, total_rounds: round },
          'llm_step_succeeded',
        );
        return { output: turn.data, usage };
      }

      // The model requested tools. Execute every call in the round FIRST, collecting
      // each outcome, before deciding the round's fate. A failed external side effect
      // is a real step failure — it must never be fed back to the model as a
      // recoverable tool result and then hidden by a subsequent "final" answer.
      const outcomes: ToolCallOutcome[] = [];
      for (const call of turn.toolCalls) {
        ordinal += 1;
        outcomes.push(await this.runToolCall({ call, refByName, toolExecutor, tenantId, execution, round, ordinal }));
      }

      const failures = outcomes.filter((o) => o.failure !== undefined);
      if (failures.length > 0) {
        // Round-level classification. If ANY failure is retryable the whole step is
        // retryable (the engine may re-run it — successful side effects in this round
        // are at-least-once and are not compensated); otherwise it is permanent.
        const retryable = failures.some((o) => o.failure!.retryable);
        const codes = failures.map((o) => o.failure!.code);
        logger?.warn(
          { provider: this.provider.name, model, round, err_codes: codes, retryable },
          'llm_step_failed',
        );
        const message = `llm tool call(s) failed in round ${round}: ${codes.join(', ')}`;
        // Carry forward the ledger's explicit reschedule hint if any failing call
        // deferred against another attempt's live reservation. Take the longest such
        // hint in the round so the retry lands past every live lease. Only meaningful
        // on the retryable path — a permanent failure never reschedules.
        const retryAfterMs = failures.reduce<number | undefined>((max, o) => {
          const hint = o.failure!.retryAfterMs;
          if (hint === undefined) return max;
          return max === undefined ? hint : Math.max(max, hint);
        }, undefined);
        const details = { round, codes, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
        if (retryable) {
          throw new RetryableError('llm_tool_call_failed', message, { details });
        }
        throw new PermanentError('llm_tool_call_failed', message, { details });
      }

      // Every call in the round succeeded — record the request turn and feed back ONLY
      // the safe, normalized results so the model can produce its final answer.
      messages.push({ role: 'assistant', toolCalls: turn.toolCalls });
      messages.push({ role: 'tool', results: outcomes.map((o) => o.result) });
    }

    // The loop bound was reached without a final answer — refuse deterministically.
    logger?.warn({ provider: this.provider.name, model, max_tool_rounds: maxRounds }, 'llm_step_failed');
    throw new PermanentError(
      'llm_tool_rounds_exceeded',
      `llm step did not produce a final answer within ${maxRounds} tool round(s)`,
      { details: { maxRounds } },
    );
  }

  /**
   * Execute one model-requested tool call. Returns the model-safe
   * {@link LlmToolResult} the model would see on success, together with the failure
   * *classification* when the call failed — the round decides what to do with it.
   *
   * The `result` is always model-safe: success carries the connector's non-secret
   * output; a failure's placeholder `result` carries only the classified
   * `{code, message}` (never a credential, connection metadata, tenant id, or
   * internal error object) so it is safe to log or feed back. But `failure`, when
   * present, additionally carries the `retryable` classification the model-facing
   * type deliberately omits — that flag drives the round's throw and never reaches
   * the model. A tool the model was not offered is refused as `unknown_tool` (a
   * deterministic wiring error, not retryable) without ever reaching the executor.
   */
  private async runToolCall(params: {
    call: LlmToolCall;
    refByName: Map<string, ConnectionRef>;
    toolExecutor: ToolExecutor;
    tenantId: string;
    execution: StepExecution;
    round: number;
    ordinal: number;
  }): Promise<ToolCallOutcome> {
    const { call, refByName, toolExecutor, tenantId, execution, round, ordinal } = params;
    const logger = execution.logger;
    logger?.info({ tool: call.name, round, call_id: call.id }, 'llm_tool_call_requested');

    const connectionRef = refByName.get(call.name);
    if (connectionRef === undefined) {
      // The model asked for a tool that was not offered to this step. A deterministic
      // wiring error — never retryable — surfaced as a round failure, not fed back.
      logger?.warn({ tool: call.name, round, call_id: call.id, err_code: 'unknown_tool' }, 'llm_tool_call_failed');
      const message = `tool "${call.name}" is not available to this step`;
      return {
        result: { id: call.id, error: { code: 'unknown_tool', message } },
        failure: { code: 'unknown_tool', retryable: false },
      };
    }

    logger?.info({ tool: call.name, round, call_id: call.id }, 'llm_tool_call_started');
    // Effect metadata lets the executor reserve this call in the ledger. It is
    // supplied ONLY when the engine gave us both a run id and a fresh per-attempt
    // stepRunId (the reservation owner): the key must be stable across attempts of
    // the same step, and the owner must be unique per attempt. Absent either, the
    // executor falls back to a direct connector call — the pre-ledger behaviour.
    const effectMetadata =
      execution.runId !== undefined && execution.stepRunId !== undefined
        ? {
            metadata: {
              idempotencyKey: `${execution.runId}:${execution.step.key}:${call.name}:${ordinal}`,
              ordinal,
              stepKey: execution.step.key,
              effectLeaseMs: DEFAULT_EFFECT_LEASE_MS,
            },
          }
        : {};
    const result = await toolExecutor.execute(
      { id: call.id, name: call.name, arguments: call.arguments },
      {
        context: {
          tenantId,
          toolName: call.name,
          ...(execution.runId !== undefined ? { runId: execution.runId } : {}),
          ...(execution.stepRunId !== undefined ? { stepRunId: execution.stepRunId } : {}),
          ...effectMetadata,
        },
        connectionRef,
        ...(logger !== undefined ? { logger } : {}),
      },
    );

    if (result.success) {
      logger?.info({ tool: call.name, round, call_id: call.id }, 'llm_tool_call_succeeded');
      return { result: { id: call.id, output: result.output } };
    }
    // Preserve the executor's classification (`retryable`) for the round-level
    // decision. The model-facing `result` still carries only the safe `{code, message}`.
    const code = result.error?.code ?? 'tool_error';
    const retryable = result.error?.retryable ?? false;
    const retryAfterMs = result.error?.retryAfterMs;
    logger?.warn({ tool: call.name, round, call_id: call.id, err_code: code }, 'llm_tool_call_failed');
    return {
      result: { id: call.id, error: { code, message: result.error?.message ?? 'tool execution failed' } },
      failure: { code, retryable, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    };
  }
}

/**
 * The internal outcome of one tool call inside the bounded loop. `result` is the
 * model-safe {@link LlmToolResult} (the only thing that could ever be fed back);
 * `failure`, present iff the call failed, additionally carries the `retryable`
 * classification the model-facing type omits, so the round can throw a
 * `RetryableError` or `PermanentError` accordingly. This type never leaves the
 * handler and is never shown to the model.
 */
interface ToolCallOutcome {
  readonly result: LlmToolResult;
  readonly failure?: {
    readonly code: string;
    readonly retryable: boolean;
    /**
     * The ledger's explicit reschedule hint, propagated from the executor's
     * {@link ToolError} when this call deferred against another attempt's live
     * reservation. The round takes the max across failures into its retryable throw.
     */
    readonly retryAfterMs?: number;
  };
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
  /**
   * The tool catalogue an `llm` step may offer the model. Omitted → an `llm` step
   * that declares `tools` fails cleanly with `llm_tools_not_configured`; a no-tools
   * step is unaffected.
   */
  readonly toolRegistry?: ToolRegistry;
  /** Builds a tenant-scoped connection resolver for a run's tenant. */
  readonly resolverFactory?: (tenantId: string) => ConnectionResolver;
  /**
   * Builds a tenant-scoped effect ledger for a run's tenant. Omitted → tool calls
   * run directly (the pre-ledger behaviour); a no-tools step is unaffected either way.
   */
  readonly effectLedgerFactory?: (tenantId: string) => EffectLedger;
}

/** The registry the worker wires in production: every step type the MVP supports. */
export function defaultStepHandlerRegistry(
  options: DefaultStepHandlerRegistryOptions = {},
): StepHandlerRegistry {
  const toolDeps: LlmToolDeps = {
    ...(options.toolRegistry !== undefined ? { toolRegistry: options.toolRegistry } : {}),
    ...(options.resolverFactory !== undefined ? { resolverFactory: options.resolverFactory } : {}),
    ...(options.effectLedgerFactory !== undefined ? { effectLedgerFactory: options.effectLedgerFactory } : {}),
  };
  const llmHandler: StepHandler =
    options.llmProvider !== undefined
      ? new LlmStepHandler(options.llmProvider, toolDeps)
      : new UnconfiguredLlmStepHandler();
  return new StepHandlerRegistry().register('noop', new NoopStepHandler()).register('llm', llmHandler);
}
