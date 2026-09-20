/**
 * The tool executor: the one place that turns a {@link ToolCall} into a
 * {@link ToolResult}, enforcing the security boundary in a fixed order.
 *
 * The order is the whole point — each step is a gate the next depends on:
 *
 *   1. **Resolve the tool** by name (unknown → {@link UnknownToolError}).
 *   2. **Validate arguments** against the tool's `inputSchema`. Invalid arguments
 *      fail here, *before* any connection is touched, decrypted, or any external
 *      call is made. Unknown fields are rejected (schemas are authored `.strict()`).
 *   3. **Authorize the connection reference.** The `connectionRef` comes from trusted
 *      platform/workflow config — NEVER from the model's `arguments` — and its
 *      provider must match the tool's provider.
 *   4. **Resolve the connection** through the tenant-scoped resolver. Because the
 *      resolver is bound to one tenant, a cross-tenant id is simply not found. A
 *      non-active connection is refused.
 *   5. **Decrypt** happens inside the resolver, at this boundary only — the decrypted
 *      credential exists just long enough to run the connector.
 *   6. **Execute** the connector with validated args + resolved credential + a
 *      least-privilege context.
 *   7. **Normalize** the outcome to a {@link ToolResult}. Any {@link AppError}
 *      becomes a classified `error`; the credential and raw arguments never appear
 *      in the result or in logs.
 *
 * The executor never retries (Step 11 owns retries). Logging is metadata-only.
 */

import { AmbiguousEffectError, PermanentError, RetryableError, isAppError } from '@/domain/errors.js';
import type { AuthorizedConnection, ConnectionRef, ConnectionResolver } from '@/domain/connection.js';
import { classifyEffectFailure } from '@/domain/effect-ledger.js';
import type { EffectLedger, EffectReservation } from '@/domain/effect-ledger.js';
import type { Connector, ToolCall, ToolContext, ToolExecutionRecord, ToolResult } from '@/domain/tool.js';
import { InvalidToolArgumentsError, UnauthorizedConnectionError } from '@/domain/tool-errors.js';
import type { ToolRegistry } from '@/domain/tool-registry.js';
import type { Logger } from '@/observability/logger.js';

/**
 * The non-secret effect metadata the step handler threads through
 * {@link ToolContext.metadata} so the executor can reserve an external effect.
 * Present only for a tool call the handler wants ledgered (it has a run/step and a
 * fresh `stepRunId` owner); absent metadata means "run the connector directly",
 * which is exactly the pre-ledger behaviour.
 */
export interface EffectMetadata {
  /** `<runId>:<stepKey>:<toolName>:<ordinal>` — the reservation key. */
  readonly idempotencyKey: string;
  /** Per-step monotonic index of this call across all rounds. */
  readonly ordinal: number;
  /** The step key issuing the call — stored on the ledger row. */
  readonly stepKey: string;
  /** The effect lease duration for this attempt, in milliseconds. */
  readonly effectLeaseMs: number;
}

/** Read {@link EffectMetadata} off a context, or undefined when the call is not ledgered. */
function readEffectMetadata(metadata: Record<string, unknown> | undefined): EffectMetadata | undefined {
  if (metadata === undefined) return undefined;
  const idempotencyKey = metadata['idempotencyKey'];
  const ordinal = metadata['ordinal'];
  const stepKey = metadata['stepKey'];
  const effectLeaseMs = metadata['effectLeaseMs'];
  if (
    typeof idempotencyKey !== 'string' ||
    typeof ordinal !== 'number' ||
    typeof stepKey !== 'string' ||
    typeof effectLeaseMs !== 'number'
  ) {
    return undefined;
  }
  return { idempotencyKey, ordinal, stepKey, effectLeaseMs };
}

/** What a single `execute` needs beyond the call itself. */
export interface ToolExecutionOptions {
  /** Least-privilege context for the connector (tenant, correlation ids, metadata). */
  readonly context: ToolContext;
  /**
   * Which connection to use. Supplied by trusted platform/workflow config, never by
   * the model. Omitted only for tools whose connector needs no credential (none in
   * 9A) — such a tool must not be given a connection.
   */
  readonly connectionRef?: ConnectionRef;
  /** Metadata-only logger; the executor binds no secrets to it. */
  readonly logger?: Logger;
}

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly resolver: ConnectionResolver,
    /**
     * The effect ledger, when external effects are to be made retry-safe. Optional:
     * without it (or without effect metadata on the call) the connector is invoked
     * directly, which is the exact pre-ledger behaviour — so nothing that does not
     * wire a ledger changes.
     */
    private readonly effectLedger?: EffectLedger,
  ) {}

  /**
   * Execute one tool call. Returns a {@link ToolResult} for both success and every
   * classified failure; it throws only for a truly unexpected (non-`AppError`)
   * condition escaping normalization, which the caller treats as a crash.
   */
  async execute(call: ToolCall, options: ToolExecutionOptions): Promise<ToolResult> {
    const { context, connectionRef, logger } = options;
    const startedAt = Date.now();
    // Filled in once (1) resolves the tool, so a later failure can still label the
    // provider. Stays undefined if the tool itself is unknown.
    let provider: string | undefined;

    try {
      // (1) Resolve the tool. Unknown → UnknownToolError.
      const tool = this.registry.resolve(call.name);
      provider = tool.provider;

      // (2) Validate arguments before anything external happens.
      const parsed = tool.inputSchema.safeParse(call.arguments);
      if (!parsed.success) {
        const issuePaths = parsed.error.issues.map((i) => i.path.join('.') || '(root)');
        throw new InvalidToolArgumentsError(call.name, issuePaths);
      }

      // (3) Authorize the connection reference against the tool's provider. The ref
      // is trusted config; still, a provider mismatch is a wiring error we refuse.
      if (connectionRef === undefined) {
        throw new UnauthorizedConnectionError(
          `tool "${call.name}" requires a connection but none was provided`,
          { toolName: call.name, provider: tool.provider },
        );
      }
      if (connectionRef.provider !== tool.provider) {
        throw new UnauthorizedConnectionError(
          `connection provider "${connectionRef.provider}" does not match tool provider "${tool.provider}"`,
          { toolName: call.name, toolProvider: tool.provider, refProvider: connectionRef.provider },
        );
      }

      // (4)+(5) Resolve the connection (tenant-scoped) and decrypt — inside the
      // resolver, at this boundary only. Missing/disabled connections throw here.
      const connection = await this.resolver.resolveForTool(connectionRef);

      // (6) Execute the connector with validated args + resolved credential —
      // through the effect ledger when this call is ledgered, directly otherwise.
      const output = await this.runConnector(tool.connector, { context, arguments: parsed.data, connection });

      // (7) Normalize success. Never echo arguments or credential.
      logger?.info(
        this.record({ context, provider: tool.provider, success: true, startedAt }),
        'tool_execution_succeeded',
      );
      return { id: call.id, name: call.name, success: true, output };
    } catch (error) {
      if (isAppError(error)) {
        logger?.warn(
          this.record({
            context,
            provider,
            success: false,
            errorCode: error.code,
            startedAt,
          }),
          'tool_execution_failed',
        );
        // Preserve the ledger's explicit reschedule hint (only ever set when an
        // attempt is deferred against another attempt's live reservation) across
        // normalization — the retry policy's backoff is far too short to honour it.
        const retryAfterMs = error.details?.['retryAfterMs'];
        return {
          id: call.id,
          name: call.name,
          success: false,
          error: {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
          },
        };
      }
      // Truly unexpected — do not swallow. The caller decides how to handle a crash.
      throw error;
    }
  }

  /**
   * Invoke the connector, wrapping it in the effect ledger's reserve → call →
   * settle protocol when the call is ledgered (a ledger is wired AND the context
   * carries {@link EffectMetadata}). Without both, it calls the connector directly
   * — byte-for-byte the original behaviour.
   *
   * The protocol, and why each branch throws what it throws:
   *   - `acquired` — WE own the reservation: run the connector, then settle the
   *     outcome (success → stored result; failure → classified by the two-axis
   *     contract) and re-throw the connector's own error so the queue/engine see
   *     the same classification a non-ledgered call would produce.
   *   - `replay`   — the effect already succeeded: return the stored result, no call.
   *   - `failed`   — it already failed deterministically: re-throw as a
   *     `PermanentError` so the run fails, no call.
   *   - `ambiguous`— its outcome is unknowable: throw an {@link AmbiguousEffectError}
   *     (a PermanentError) so the run fails operator-visibly, never a silent resend.
   *   - `defer`    — another attempt holds a LIVE reservation: throw a retryable
   *     error carrying `retryAfterMs`, so the job reschedules past that lease.
   */
  private async runConnector(
    connector: Connector,
    request: { context: ToolContext; arguments: unknown; connection: AuthorizedConnection },
  ): Promise<unknown> {
    const effect = readEffectMetadata(request.context.metadata);
    const owner = request.context.stepRunId;
    const runId = request.context.runId;

    // Not ledgered: no ledger wired, no effect metadata, or no owner/run to key on.
    // Behave exactly as before.
    if (this.effectLedger === undefined || effect === undefined || owner === undefined || runId === undefined) {
      return connector.execute(request);
    }

    const reservation: EffectReservation = {
      tenantId: request.context.tenantId,
      runId,
      stepKey: effect.stepKey,
      toolName: request.context.toolName,
      ordinal: effect.ordinal,
      idempotencyKey: effect.idempotencyKey,
      provider: connector.provider,
      owner,
      leaseMs: effect.effectLeaseMs,
    };

    const acquisition = await this.effectLedger.acquire(reservation);

    switch (acquisition.kind) {
      case 'replay':
        return acquisition.result;
      case 'failed':
        throw new PermanentError(acquisition.error.code, acquisition.error.message);
      case 'ambiguous':
        throw new AmbiguousEffectError(
          `external effect outcome is unknown and cannot be safely retried (${acquisition.error.code})`,
          { details: { effectCode: acquisition.error.code } },
        );
      case 'defer':
        // Retryable, but the schedule is dictated by the live reservation's lease,
        // not the backoff curve — carried as `retryAfterMs` through to settleStep.
        throw new RetryableError(
          'effect_pending_elsewhere',
          'another attempt holds a live reservation for this external effect; deferring past its lease',
          { details: { retryAfterMs: acquisition.retryAfterMs } },
        );
      case 'acquired':
        break;
    }

    // WE own the reservation. Run the connector and settle by outcome.
    let output: unknown;
    try {
      output = await connector.execute(request);
    } catch (error) {
      const disposition = classifyEffectFailure(error, connector.recoveryPolicy ?? 'hold_ambiguous');
      await this.effectLedger.settleFailure(reservation, disposition);
      if (disposition.kind === 'ambiguous') {
        // The connector's raw error may have been retryable; the ledger's verdict
        // is that the outcome is unknowable, so it must surface as ambiguous
        // (permanent) — never as a retryable failure that would resend the effect.
        throw new AmbiguousEffectError(
          `external effect outcome is unknown and cannot be safely retried (${disposition.error.code})`,
          { cause: error, details: { effectCode: disposition.error.code } },
        );
      }
      // release (safe retryable) or permanent: re-throw the connector's own error
      // unchanged, so the queue sees the identical classification it always would.
      throw error;
    }

    await this.effectLedger.settleSuccess(reservation, output);
    return output;
  }

  /** Build the metadata-only execution record used for logging. Never holds secrets. */
  private record(input: {
    context: ToolContext;
    provider?: string | undefined;
    success: boolean;
    errorCode?: string;
    startedAt: number;
  }): ToolExecutionRecord {
    const { context } = input;
    return {
      toolName: context.toolName,
      provider: input.provider ?? 'unknown',
      tenantId: context.tenantId,
      ...(context.runId !== undefined ? { runId: context.runId } : {}),
      ...(context.stepRunId !== undefined ? { stepRunId: context.stepRunId } : {}),
      success: input.success,
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      latencyMs: Date.now() - input.startedAt,
    };
  }
}
