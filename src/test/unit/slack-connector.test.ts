/**
 * Slack connector unit tests — with a fake transport, never the real Slack API.
 *
 * These prove the connector's contract: it sends exactly the right chat.postMessage
 * request, the bot token reaches only the transport (never the result, logs, or a
 * normalized error), the small success shape is returned, and every documented Slack
 * failure maps onto the right taxonomy (permanent vs retryable) without being retried.
 */

import { describe, expect, it, vi } from 'vitest';

import { PermanentError, RetryableError } from '@/domain/errors.js';
import { SlackConnector } from '@/connectors/slack/slack-connector.js';
import type { SlackMessageArgs } from '@/connectors/slack/slack-connector.js';
import type { AuthorizedConnection } from '@/domain/connection.js';
import type { ConnectorRequest, ToolContext } from '@/domain/tool.js';
import { FakeSlackTransport } from '@/test/support/fake-slack-transport.js';

const BOT_TOKEN = 'xoxb-UNIT-TEST-SECRET-TOKEN';
const CONTEXT: ToolContext = { tenantId: 't1', runId: 'r1', stepRunId: 's1', toolName: 'send_slack_message' };

function connection(credential: Record<string, unknown> = { botToken: BOT_TOKEN }): AuthorizedConnection {
  return {
    metadata: {
      id: 'conn-slack-1',
      provider: 'slack',
      name: 'dev',
      status: 'active',
      metadata: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
      lastUsedAt: null,
    },
    credential,
  };
}

function request(args: SlackMessageArgs, cred?: Record<string, unknown>): ConnectorRequest<SlackMessageArgs> {
  return { context: CONTEXT, arguments: args, connection: connection(cred) };
}

describe('SlackConnector success', () => {
  it('posts the exact channel and text and returns a small non-secret result', async () => {
    const transport = new FakeSlackTransport({
      response: { status: 200, body: { ok: true, channel: 'C999', ts: '1700.500' } },
    });
    const connector = new SlackConnector({ transport });

    const result = await connector.execute(request({ channel: '#ai-workforce-test', text: 'hello' }));

    expect(transport.calls).toBe(1);
    expect(transport.lastInput).toEqual({ channel: '#ai-workforce-test', text: 'hello' });
    // The bot token reached ONLY the transport.
    expect(transport.lastToken).toBe(BOT_TOKEN);
    expect(result).toEqual({ ok: true, channel: 'C999', ts: '1700.500' });
  });

  it('never returns the bot token in the result', async () => {
    const connector = new SlackConnector({ transport: new FakeSlackTransport() });
    const result = await connector.execute(request({ channel: 'C1', text: 'hi' }));
    expect(JSON.stringify(result)).not.toContain(BOT_TOKEN);
  });

  it('never logs the bot token', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const logger = { info, warn, error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never;
    const connector = new SlackConnector({ transport: new FakeSlackTransport(), logger });

    await connector.execute(request({ channel: 'C1', text: 'secret business text' }));

    const logged = JSON.stringify(info.mock.calls.concat(warn.mock.calls));
    expect(logged).not.toContain(BOT_TOKEN);
    // The message text is not logged by default either.
    expect(logged).not.toContain('secret business text');
  });
});

describe('SlackConnector credential handling', () => {
  it('rejects a connection whose credential lacks a botToken (permanent)', async () => {
    const connector = new SlackConnector({ transport: new FakeSlackTransport() });
    await expect(connector.execute(request({ channel: 'C1', text: 'hi' }, { notAToken: 'x' }))).rejects.toBeInstanceOf(
      PermanentError,
    );
  });
});

describe('SlackConnector error mapping', () => {
  const run = async (transport: FakeSlackTransport) =>
    new SlackConnector({ transport }).execute(request({ channel: 'C1', text: 'hi' })).then(
      () => undefined,
      (e: unknown) => e,
    );

  it.each(['invalid_auth', 'token_revoked', 'channel_not_found', 'not_in_channel', 'missing_scope', 'no_permission'])(
    'maps Slack error %s to a PermanentError with that code',
    async (error) => {
      const e = await run(new FakeSlackTransport({ response: { status: 200, body: { ok: false, error } } }));
      expect(e).toBeInstanceOf(PermanentError);
      expect((e as PermanentError).code).toBe(error);
      expect((e as PermanentError).retryable).toBe(false);
      // The token never leaks into the error.
      expect(JSON.stringify({ msg: (e as Error).message, code: (e as PermanentError).code })).not.toContain(BOT_TOKEN);
    },
  );

  it('maps a Slack ratelimited body to a RetryableError', async () => {
    const e = await run(new FakeSlackTransport({ response: { status: 200, body: { ok: false, error: 'ratelimited' } } }));
    expect(e).toBeInstanceOf(RetryableError);
    expect((e as RetryableError).code).toBe('slack_rate_limited');
  });

  it('classifies HTTP 429 as retryable and retains Retry-After as safe metadata (no retry here)', async () => {
    const e = await run(
      new FakeSlackTransport({ response: { status: 429, retryAfterSeconds: 30, body: { ok: false, error: 'ratelimited' } } }),
    );
    expect(e).toBeInstanceOf(RetryableError);
    expect((e as RetryableError).code).toBe('slack_rate_limited');
    expect((e as RetryableError).details).toEqual({ retryAfterSeconds: 30 });
  });

  it('classifies a transient HTTP 5xx as retryable', async () => {
    const e = await run(new FakeSlackTransport({ response: { status: 503, body: { ok: false, error: 'service_unavailable' } } }));
    expect(e).toBeInstanceOf(RetryableError);
    expect((e as RetryableError).code).toBe('slack_http_5xx');
  });

  it('classifies a transport/network/timeout failure as retryable', async () => {
    const e = await run(new FakeSlackTransport({ throwError: new Error('aborted') }));
    expect(e).toBeInstanceOf(RetryableError);
    expect((e as RetryableError).code).toBe('slack_network_error');
    // The underlying cause is preserved but carries no token.
    expect(JSON.stringify((e as RetryableError).message)).not.toContain(BOT_TOKEN);
  });
});
