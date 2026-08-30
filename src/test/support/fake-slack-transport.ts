/**
 * A fake Slack transport for tests. Records the exact request (channel, text, and the
 * bot token it received) and returns a scripted {@link SlackHttpResponse} — or throws
 * a scripted transport error to simulate a network/timeout failure.
 *
 * The normal test suite MUST NOT reach the real Slack API; this is how. It also lets
 * a test assert that the bot token reaches the transport and nowhere else.
 */

import type {
  SlackHttpResponse,
  SlackPostMessageInput,
  SlackTransport,
} from '@/connectors/slack/slack-client.js';

export interface FakeSlackTransportOptions {
  /** The HTTP response to resolve with. Defaults to a success. */
  readonly response?: SlackHttpResponse;
  /** If set, `postMessage` rejects with this (simulates network/timeout). */
  readonly throwError?: Error;
}

export class FakeSlackTransport implements SlackTransport {
  calls = 0;
  lastInput: SlackPostMessageInput | undefined;
  lastToken: string | undefined;

  private readonly response: SlackHttpResponse;
  private readonly throwError: Error | undefined;

  constructor(options: FakeSlackTransportOptions = {}) {
    this.response = options.response ?? {
      status: 200,
      body: { ok: true, channel: 'C123TEST', ts: '1700000000.000100' },
    };
    this.throwError = options.throwError;
  }

  postMessage(input: SlackPostMessageInput, botToken: string): Promise<SlackHttpResponse> {
    this.calls += 1;
    this.lastInput = input;
    this.lastToken = botToken;
    if (this.throwError !== undefined) return Promise.reject(this.throwError);
    return Promise.resolve(this.response);
  }
}
