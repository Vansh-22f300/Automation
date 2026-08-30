/**
 * Tool-layer error taxonomy.
 *
 * These are the deterministic, classify-don't-retry failures the tool executor and
 * registry raise. Every one is a {@link PermanentError} with a stable `code` so the
 * executor can normalize it into a {@link ToolResult.error} without string-matching,
 * and so metrics/logs have a machine-readable label. None of them ever carries the
 * tool arguments, the connection credential, or the connector's output — only ids
 * and names that are already non-secret.
 *
 * Connector *failures* (the external call itself going wrong) are NOT here: a
 * connector maps its vendor errors onto the shared {@link RetryableError} /
 * {@link PermanentError} taxonomy (e.g. code `connector_failure`). Step 9A never
 * auto-retries — retries are Step 11 — so a `RetryableError` from a connector is
 * classified and surfaced, not looped on.
 */

import { PermanentError } from '@/domain/errors.js';

/** The tool name did not resolve to a registered tool. */
export class UnknownToolError extends PermanentError {
  constructor(toolName: string) {
    super('unknown_tool', `no tool registered with name "${toolName}"`, { details: { toolName } });
  }
}

/** A tool with this name is already registered. Registration is fail-fast. */
export class DuplicateToolRegistrationError extends PermanentError {
  constructor(toolName: string) {
    super('duplicate_tool_registration', `a tool named "${toolName}" is already registered`, {
      details: { toolName },
    });
  }
}

/**
 * The tool arguments failed the tool's `inputSchema`. Raised before any connection
 * resolution or external call. Carries a compact list of field paths that failed —
 * never the offending values, which may be untrusted or sensitive.
 */
export class InvalidToolArgumentsError extends PermanentError {
  constructor(toolName: string, issuePaths: readonly string[]) {
    super('invalid_tool_arguments', `arguments for tool "${toolName}" failed validation`, {
      details: { toolName, issuePaths },
    });
  }
}

/**
 * The connection reference was not authorized for this context (e.g. its provider
 * does not match the tool's provider). A deliberate refusal, distinct from "not
 * found".
 */
export class UnauthorizedConnectionError extends PermanentError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('unauthorized_connection', message, details !== undefined ? { details } : undefined);
  }
}

/**
 * No connection resolved for the requested provider/id within this tenant. A
 * cross-tenant id lands here too: it simply does not exist for this scope, and the
 * error deliberately does not distinguish "another tenant owns it" from "nobody
 * does".
 */
export class MissingConnectionError extends PermanentError {
  constructor(ref: { provider: string; connectionId?: string }) {
    super('missing_connection', `no active connection found for provider "${ref.provider}"`, {
      details: { provider: ref.provider, ...(ref.connectionId !== undefined ? { connectionId: ref.connectionId } : {}) },
    });
  }
}

/** A connection was found but its status is `disabled` or `error`, so it is refused. */
export class DisabledConnectionError extends PermanentError {
  constructor(connectionId: string, status: string) {
    super('disabled_connection', `connection "${connectionId}" is not active (status: ${status})`, {
      details: { connectionId, status },
    });
  }
}
