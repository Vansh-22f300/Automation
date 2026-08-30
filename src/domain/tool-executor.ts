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

import { isAppError } from '@/domain/errors.js';
import type { ConnectionRef, ConnectionResolver } from '@/domain/connection.js';
import type { ToolCall, ToolContext, ToolExecutionRecord, ToolResult } from '@/domain/tool.js';
import { InvalidToolArgumentsError, UnauthorizedConnectionError } from '@/domain/tool-errors.js';
import type { ToolRegistry } from '@/domain/tool-registry.js';
import type { Logger } from '@/observability/logger.js';

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

      // (6) Execute the connector with validated args + resolved credential.
      const output = await tool.connector.execute({
        context,
        arguments: parsed.data,
        connection,
      });

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
        return {
          id: call.id,
          name: call.name,
          success: false,
          error: { code: error.code, message: error.message, retryable: error.retryable },
        };
      }
      // Truly unexpected — do not swallow. The caller decides how to handle a crash.
      throw error;
    }
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
