/**
 * The `send_slack_message` tool: the registered binding of a strict argument schema
 * to the {@link SlackConnector}.
 *
 * The schema is deliberately minimal — `channel` and `text`, nothing else. It is
 * `.strict()`, so any extra field (a model trying to smuggle a `connectionId`,
 * `tenantId`, `token`, `url`, or request body) is rejected by validation before any
 * connection is resolved, decrypted, or any Slack call is made. The connection is
 * chosen by trusted config via the executor's `connectionRef`, never by these args.
 */

import { z } from 'zod';

import type { ToolDefinition } from '@/domain/tool.js';

import { SLACK_PROVIDER } from './slack-connector.js';
import type { SlackConnector, SlackMessageArgs } from './slack-connector.js';

export const SEND_SLACK_MESSAGE_TOOL = 'send_slack_message';

/**
 * Strict argument schema. Only `channel` and `text`; unknown keys are rejected.
 * `channel` is a Slack channel id or name; `text` is the message body.
 */
export const sendSlackMessageSchema = z
  .object({
    channel: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();

/** Build the tool definition, binding the schema to a Slack connector instance. */
export function createSendSlackMessageTool(connector: SlackConnector): ToolDefinition<SlackMessageArgs> {
  return {
    name: SEND_SLACK_MESSAGE_TOOL,
    description:
      'Post a message to a Slack channel the bot is a member of. Requires a Slack ' +
      'connection; the connection is chosen by trusted platform configuration, not by ' +
      'this tool’s arguments.',
    provider: SLACK_PROVIDER,
    inputSchema: sendSlackMessageSchema,
    connector,
  };
}
