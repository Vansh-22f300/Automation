/**
 * The tool / connector contract — the model-independent seam through which a
 * workflow step will (in a later step) reach an external service, and nothing else.
 *
 * The layering, and the security boundary each layer enforces:
 *
 *   ToolCall  — a request to run a named tool with some arguments. Model-shaped
 *               (`id`, `name`, `arguments`) but NOT tied to any vendor's tool-calling
 *               format. In 9A nothing auto-executes a ToolCall; the executor is
 *               invoked deliberately by trusted code.
 *   ToolDefinition — binds a `name` + `description` + Zod `inputSchema` to a single
 *               {@link Connector}. Execution is delegated to that connector; there is
 *               no field for a URL, an HTTP method, a script, or a shell command. A
 *               tool can only do what its connector's code does.
 *   Connector — provider-neutral executor. Receives already-*validated* arguments,
 *               the resolved (decrypted) credential, and a least-privilege context.
 *               It has no way to obtain a different tenant's credential or to be
 *               pointed at an arbitrary URL by its caller.
 *   ToolResult — the normalized outcome. Success carries a connector output; failure
 *               carries a classified `{code, message, retryable}`. Never the
 *               credential, never the raw arguments.
 *
 * This module is pure: no SDK, no database, no framework. Zod is the one dependency,
 * and only as the type of `inputSchema`.
 */

import type { ZodType } from 'zod';

import type { AuthorizedConnection } from '@/domain/connection.js';

/**
 * A request to execute a tool. Deliberately model-independent: a future adapter maps
 * a vendor's tool-use block onto this shape, but the executor and connectors never
 * see the vendor format. `arguments` is untrusted until validated by the tool's
 * `inputSchema`.
 */
export interface ToolCall {
  /** Correlates the call with its result. Opaque to this layer. */
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

/** A classified tool failure, carried in {@link ToolResult}. Never holds secrets. */
export interface ToolError {
  /** Stable machine-readable code (e.g. `unknown_tool`, `connector_failure`). */
  readonly code: string;
  readonly message: string;
  /**
   * Whether re-executing could plausibly succeed. Carried forward from the error's
   * classification for the retry engine.
   */
  readonly retryable: boolean;
  /**
   * An explicit reschedule hint, in milliseconds, that must OVERRIDE the retry
   * policy's backoff for this failure. Set only by the effect ledger when it
   * defers an attempt against another attempt's LIVE reservation: the deferral
   * has to outlast that reservation's lease, which the exponential backoff curve
   * (a ~15-31s total budget) is far too short to guarantee. Absent for every
   * ordinary failure, whose scheduling stays the retry policy's business.
   */
  readonly retryAfterMs?: number;
}

/**
 * The normalized outcome of executing a {@link ToolCall}. Exactly one of
 * `output`/`error` is meaningful per `success`. `output` is a connector-shaped,
 * non-secret result; `error` is a classified failure. The credential never appears
 * in either.
 */
export interface ToolResult {
  readonly id: string;
  readonly name: string;
  readonly success: boolean;
  readonly output?: unknown;
  readonly error?: ToolError;
}

/**
 * Least-privilege execution context handed to a connector. It carries only what a
 * connector legitimately needs for correlation and logging — never the whole
 * workflow run context, never the run's accumulated data.
 */
export interface ToolContext {
  readonly tenantId: string;
  readonly runId?: string;
  readonly stepRunId?: string;
  /** The tool being executed — for the connector's own metadata-only logging. */
  readonly toolName: string;
  /** Optional non-secret request metadata (e.g. an idempotency hint). Never secrets. */
  readonly metadata?: Record<string, unknown>;
}

/**
 * What a {@link Connector} receives: the least-privilege context, the *validated*
 * arguments (parsed by the tool's `inputSchema`, unknown fields already rejected),
 * and the resolved connection whose decrypted credential authorizes the call.
 */
export interface ConnectorRequest<Args = unknown> {
  readonly context: ToolContext;
  readonly arguments: Args;
  readonly connection: AuthorizedConnection;
}

/**
 * Whether repeating an external effect is *safe*, as asserted by the connector
 * that raised the failure. This is orthogonal to the queue's `retryable` flag:
 * `retryable` says a retry could succeed; `effectSafety` says whether re-running
 * the operation risks a duplicate external effect.
 *
 * - `safe`      — the connector GUARANTEES the external write did NOT execute
 *                 (e.g. a structured pre-flight rate-limit rejection, an HTTP 429
 *                 before the request was accepted). Only then may the effect
 *                 ledger release the reservation for a genuine re-execution.
 * - `ambiguous` — the outcome cannot be established: the write may have happened.
 *                 The ledger must NOT auto-resend a `hold_ambiguous` effect.
 *
 * A connector carries this on the raised error as `details.effectSafety` (see
 * {@link EFFECT_SAFETY_DETAIL_KEY}). It is INTERNAL, TRUSTED metadata set in
 * connector code — never derived from a model, tool arguments, or an external
 * payload. The fail-safe rule is absolute: a missing or unrecognised value is
 * treated as `ambiguous`. There is no third "unknown" state at rest — the
 * ledger collapses anything that is not explicitly `safe` to `ambiguous`.
 */
export type EffectSafety = 'safe' | 'ambiguous';

/**
 * The key under which a connector tags an error's {@link ErrorDetails} with its
 * {@link EffectSafety} assertion. Centralised so the connector that writes it and
 * the ledger that reads it cannot drift on a string literal.
 */
export const EFFECT_SAFETY_DETAIL_KEY = 'effectSafety';

/**
 * How the effect ledger recovers a reservation whose outcome is unknown
 * (`ambiguous`) — the connector-declared policy for its whole provider.
 *
 * - `resend_safe`    — resend automatically. ONLY valid for a genuinely
 *                      idempotent effect (a provider-side idempotency key, or a
 *                      naturally idempotent operation). Not implemented yet.
 * - `reconcile`      — query the provider to discover whether the effect landed,
 *                      then settle accordingly. Requires a provider read path.
 *                      Not implemented yet.
 * - `hold_ambiguous` — do nothing automatic: settle the effect `ambiguous`, fail
 *                      the run operator-visibly, never resend. The only safe
 *                      default for a non-idempotent effect, and the only policy
 *                      implemented in this step.
 *
 * A connector without a `recoveryPolicy` is treated as `hold_ambiguous`: the
 * safe default, never a silent resend.
 */
export type EffectRecoveryPolicy = 'resend_safe' | 'reconcile' | 'hold_ambiguous';

/**
 * A provider-neutral executor for one provider's operations. It is handed validated
 * arguments and a resolved credential and returns a non-secret output, or throws a
 * classified error. It must never return the credential or a raw token in its
 * output, and it has no mechanism to be pointed at a caller-chosen URL.
 */
export interface Connector<Args = unknown> {
  /** Stable provider identifier (e.g. 'slack'). Matches the connection's provider. */
  readonly provider: string;
  /**
   * How the effect ledger should recover an ambiguous effect from this provider.
   * Omitted ⇒ {@link EffectRecoveryPolicy} `hold_ambiguous` — the safe default.
   * The ledger reads this only when it has already decided an outcome is
   * ambiguous; a `safe` retryable failure is released regardless of this value.
   */
  readonly recoveryPolicy?: EffectRecoveryPolicy;
  execute(request: ConnectorRequest<Args>): Promise<unknown>;
}

/**
 * A registered tool: a name and human description, the provider it acts against, the
 * Zod schema its arguments must satisfy, and the connector that performs the work.
 *
 * Authors should build `inputSchema` with `.strict()` so unknown fields are rejected
 * rather than silently passed to the connector. There is intentionally no `url`,
 * `method`, `handler`, or `code` field: a tool's behaviour is entirely the bound
 * connector's, which is defined in code and reviewed — not supplied at call time.
 */
export interface ToolDefinition<Args = unknown> {
  readonly name: string;
  readonly description: string;
  readonly provider: string;
  readonly inputSchema: ZodType<Args>;
  readonly connector: Connector<Args>;
}

/** The non-secret facts about a registered tool, safe to list/expose. */
export interface ToolMetadata {
  readonly name: string;
  readonly description: string;
  readonly provider: string;
}

/** Project a definition to its non-secret metadata. */
export function toToolMetadata(definition: ToolDefinition): ToolMetadata {
  return { name: definition.name, description: definition.description, provider: definition.provider };
}

/**
 * A structured, log-safe record of one tool execution. This is the deliberately
 * minimal alternative to a premature generic audit table (Step 9A ships no audit
 * schema): metadata only — ids, names, outcome, duration — never arguments, output,
 * or credential. A future step can persist these if an audit requirement is proven.
 */
export interface ToolExecutionRecord {
  readonly toolName: string;
  readonly provider: string;
  readonly tenantId: string;
  readonly runId?: string;
  readonly stepRunId?: string;
  readonly success: boolean;
  readonly errorCode?: string;
  readonly latencyMs: number;
}
