/**
 * `send_slack_message` through the generic ToolExecutor — proving the full trusted
 * chain with fakes (no real Slack, no real DB):
 *
 *   ToolCall → tool resolve → strict arg validation → trusted connectionRef →
 *   connection resolve → decrypt (fake) → SlackConnector → normalized ToolResult.
 *
 * The focus here is the executor↔Slack seam: strict args gate the connector, a
 * model-supplied connection selector cannot override the trusted `connectionRef`, and
 * the bot token never surfaces in the result or logs.
 */

import { describe, expect, it, vi } from 'vitest';

import { createSendSlackMessageTool } from '@/connectors/slack/send-slack-message.js';
import { SlackConnector } from '@/connectors/slack/slack-connector.js';
import type { AuthorizedConnection } from '@/domain/connection.js';
import type { ToolCall, ToolContext } from '@/domain/tool.js';
import { ToolExecutor } from '@/domain/tool-executor.js';
import { ToolRegistry } from '@/domain/tool-registry.js';
import { FakeConnectionResolver } from '@/test/support/fake-connector.js';
import { FakeSlackTransport } from '@/test/support/fake-slack-transport.js';

const BOT_TOKEN = 'xoxb-EXECUTOR-TEST-SECRET';
const CONTEXT: ToolContext = { tenantId: 't1', runId: 'r1', stepRunId: 's1', toolName: 'send_slack_message' };

const slackConnection: AuthorizedConnection = {
  metadata: {
    id: 'conn-slack-A',
    provider: 'slack',
    name: 'dev',
    status: 'active',
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastUsedAt: null,
  },
  credential: { botToken: BOT_TOKEN },
};

function build(transport = new FakeSlackTransport()) {
  const connector = new SlackConnector({ transport });
  const registry = new ToolRegistry().register(createSendSlackMessageTool(connector));
  const resolver = new FakeConnectionResolver({ connection: slackConnection });
  return { executor: new ToolExecutor(registry, resolver), transport, resolver };
}

const call = (args: unknown): ToolCall => ({ id: 'c1', name: 'send_slack_message', arguments: args });
const trustedRef = { provider: 'slack', connectionId: 'conn-slack-A' } as const;

describe('send_slack_message via ToolExecutor', () => {
  it('validates, resolves the trusted connection, executes, and normalizes', async () => {
    const { executor, transport, resolver } = build();
    const result = await executor.execute(call({ channel: '#ai-workforce-test', text: 'hi' }), {
      context: CONTEXT,
      connectionRef: trustedRef,
    });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ ok: true, channel: 'C123TEST', ts: '1700000000.000100' });
    expect(transport.lastInput).toEqual({ channel: '#ai-workforce-test', text: 'hi' });
    // The resolver saw ONLY the trusted ref.
    expect(resolver.lastRef).toEqual(trustedRef);
  });

  it('rejects invalid arguments before the connector runs', async () => {
    const { executor, transport, resolver } = build();
    const result = await executor.execute(call({ channel: 'C1' }), { context: CONTEXT, connectionRef: trustedRef });
    expect(result.error?.code).toBe('invalid_tool_arguments');
    expect(resolver.resolveCalls).toBe(0);
    expect(transport.calls).toBe(0);
  });

  it('rejects a model-supplied connection selector via the strict schema (no execution)', async () => {
    const { executor, transport, resolver } = build();
    const result = await executor.execute(
      call({ channel: 'C1', text: 'hi', connectionId: 'attacker-selected', tenantId: 'victim' }),
      { context: CONTEXT, connectionRef: trustedRef },
    );
    expect(result.error?.code).toBe('invalid_tool_arguments');
    expect(resolver.resolveCalls).toBe(0);
    expect(transport.calls).toBe(0);
  });

  it('never leaks the bot token into the result or logs', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const logger = { info, warn, error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never;
    const { executor } = build();
    const result = await executor.execute(call({ channel: 'C1', text: 'hi' }), {
      context: CONTEXT,
      connectionRef: trustedRef,
      logger,
    });
    const serialized = JSON.stringify({ result, calls: info.mock.calls.concat(warn.mock.calls) });
    expect(serialized).not.toContain(BOT_TOKEN);
  });
});
