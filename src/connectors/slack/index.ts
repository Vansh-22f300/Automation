/**
 * Slack connector wiring. One place that assembles the transport → connector → tool
 * → registry chain, so the CLI, tests, and (later) the worker build it identically.
 *
 * Nothing here is Slack-token-aware: the token lives only in an encrypted connection
 * and is decrypted at the execution boundary by the generic Step 9A infrastructure.
 */

import { ToolRegistry } from '@/domain/tool-registry.js';
import type { Logger } from '@/observability/logger.js';

import { createFetchSlackTransport } from './slack-client.js';
import type { SlackTransport } from './slack-client.js';
import { SlackConnector } from './slack-connector.js';
import { createSendSlackMessageTool } from './send-slack-message.js';

export interface SlackToolsOptions {
  /** Transport to use; defaults to the real fetch-based Slack client. */
  readonly transport?: SlackTransport;
  /** Metadata-only logger passed to the connector. */
  readonly logger?: Logger;
}

/** Build a {@link ToolRegistry} containing exactly the Slack tool(s) for this step. */
export function createSlackToolRegistry(options: SlackToolsOptions = {}): ToolRegistry {
  const transport = options.transport ?? createFetchSlackTransport();
  const connector = new SlackConnector({
    transport,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
  return new ToolRegistry().register(createSendSlackMessageTool(connector));
}

export { SlackConnector, SLACK_PROVIDER } from './slack-connector.js';
export type { SlackMessageArgs, SlackMessageResult } from './slack-connector.js';
export { SEND_SLACK_MESSAGE_TOOL, sendSlackMessageSchema, createSendSlackMessageTool } from './send-slack-message.js';
export { createFetchSlackTransport } from './slack-client.js';
export type { SlackTransport, SlackHttpResponse, SlackPostMessageInput } from './slack-client.js';
