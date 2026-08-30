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
   * classification for the future retry engine (Step 11); 9A never acts on it.
   */
  readonly retryable: boolean;
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
 * A provider-neutral executor for one provider's operations. It is handed validated
 * arguments and a resolved credential and returns a non-secret output, or throws a
 * classified error. It must never return the credential or a raw token in its
 * output, and it has no mechanism to be pointed at a caller-chosen URL.
 */
export interface Connector<Args = unknown> {
  /** Stable provider identifier (e.g. 'slack'). Matches the connection's provider. */
  readonly provider: string;
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
