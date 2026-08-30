/**
 * The Slack connector: turns validated `send_slack_message` arguments plus a
 * decrypted bot credential into a single `chat.postMessage` call, and normalizes the
 * outcome into a small, non-secret result or a classified error.
 *
 * It receives only what a {@link Connector} is given — a least-privilege
 * {@link ToolContext}, the *validated* arguments, and the resolved
 * {@link AuthorizedConnection}. It never sees the workflow context, a DB handle, or
 * the encrypted envelope. The bot token flows from the decrypted credential to the
 * Slack transport and nowhere else: it is never returned, never logged, never placed
 * in an error.
 *
 * Logging is metadata-only (`slack_tool_started/succeeded/failed`) — ids, provider,
 * channel, latency, safe error code. The message text is NOT logged by default, as it
 * may carry business content.
 */

import { PermanentError, RetryableError } from '@/domain/errors.js';
import type { Connector, ConnectorRequest } from '@/domain/tool.js';
import type { Logger } from '@/observability/logger.js';

import type { SlackPostMessageInput, SlackTransport } from './slack-client.js';

/** The provider identifier this connector and its connections use. */
export const SLACK_PROVIDER = 'slack';

/** The validated argument shape (mirrors the tool's Zod schema). */
export interface SlackMessageArgs {
  readonly channel: string;
  readonly text: string;
}

/** The small, non-secret success shape stored for workflow continuation. */
export interface SlackMessageResult {
  readonly ok: true;
  readonly channel: string;
  readonly ts: string;
}

/**
 * Slack `ok:false` error strings that are transient — the only class we mark
 * retryable. Everything else Slack reports is deterministic (bad channel, bad auth,
 * missing scope, …) and must not be retried.
 */
const RETRYABLE_SLACK_ERRORS = new Set([
  'ratelimited',
  'rate_limited',
  'internal_error',
  'service_unavailable',
  'fatal_error',
  'request_timeout',
]);

export interface SlackConnectorOptions {
  readonly transport: SlackTransport;
  /** Metadata-only logger. The connector binds no secrets to it. */
  readonly logger?: Logger;
}

export class SlackConnector implements Connector<SlackMessageArgs> {
  readonly provider = SLACK_PROVIDER;

  private readonly transport: SlackTransport;
  private readonly logger: Logger | undefined;

  constructor(options: SlackConnectorOptions) {
    this.transport = options.transport;
    this.logger = options.logger;
  }

  async execute(request: ConnectorRequest<SlackMessageArgs>): Promise<SlackMessageResult> {
    const { context, arguments: args, connection } = request;
    const startedAt = Date.now();
    const base = {
      tenant_id: context.tenantId,
      ...(context.runId !== undefined ? { run_id: context.runId } : {}),
      ...(context.stepRunId !== undefined ? { step_run_id: context.stepRunId } : {}),
      tool: context.toolName,
      provider: this.provider,
      connection_id: connection.metadata.id,
      channel: args.channel,
    };
    this.logger?.info(base, 'slack_tool_started');

    const botToken = this.extractBotToken(connection.credential);

    let response;
    try {
      response = await this.transport.postMessage({ channel: args.channel, text: args.text } satisfies SlackPostMessageInput, botToken);
    } catch (cause) {
      // Transport-level failure: network reset, DNS, timeout/abort. Transient.
      const error = new RetryableError('slack_network_error', 'Slack request failed at the transport layer', { cause });
      this.logFailure(base, startedAt, error.code);
      throw error;
    }

    const error = this.classify(response);
    if (error !== undefined) {
      this.logFailure(base, startedAt, error.code);
      throw error;
    }

    const result: SlackMessageResult = {
      ok: true,
      channel: response.body.channel ?? args.channel,
      ts: response.body.ts ?? '',
    };
    this.logger?.info({ ...base, latency_ms: Date.now() - startedAt, ts: result.ts }, 'slack_tool_succeeded');
    return result;
  }

  /** Pull the bot token from the decrypted credential; a missing one is a config error. */
  private extractBotToken(credential: Record<string, unknown>): string {
    const token = credential['botToken'];
    if (typeof token !== 'string' || token.length === 0) {
      // Deterministic misconfiguration — not retryable. The token value is never
      // included, only the fact that it was absent/malformed.
      throw new PermanentError('slack_credential_invalid', 'Slack connection credential is missing a valid botToken');
    }
    return token;
  }

  /**
   * Map an HTTP outcome onto the error taxonomy. Returns undefined on success.
   * The Slack error string becomes the stable `code`; the token never appears.
   */
  private classify(response: {
    status: number;
    retryAfterSeconds?: number;
    body: { ok: boolean; error?: string };
  }): PermanentError | RetryableError | undefined {
    const { status, retryAfterSeconds, body } = response;

    // Rate limited: honour Slack's 429 + Retry-After. Transient.
    if (status === 429 || body.error === 'ratelimited' || body.error === 'rate_limited') {
      return new RetryableError('slack_rate_limited', 'Slack rate-limited the request', {
        details: retryAfterSeconds !== undefined ? { retryAfterSeconds } : {},
      });
    }
    // Transient server-side HTTP failures.
    if (status >= 500) {
      return new RetryableError('slack_http_5xx', `Slack returned HTTP ${status}`, { details: { status } });
    }
    // Any other non-2xx with no usable body: deterministic from our side.
    if (status < 200 || status >= 300) {
      if (body.ok === true) return undefined;
      return new PermanentError('slack_http_error', `Slack returned HTTP ${status}`, { details: { status } });
    }
    // 2xx but application-level failure: classify by Slack's error string.
    if (body.ok !== true) {
      const code = body.error ?? 'unknown_error';
      if (RETRYABLE_SLACK_ERRORS.has(code)) {
        return new RetryableError(code, `Slack API error: ${code}`);
      }
      return new PermanentError(code, `Slack API error: ${code}`);
    }
    return undefined;
  }

  private logFailure(base: Record<string, unknown>, startedAt: number, code: string): void {
    this.logger?.warn({ ...base, latency_ms: Date.now() - startedAt, error_code: code }, 'slack_tool_failed');
  }
}
