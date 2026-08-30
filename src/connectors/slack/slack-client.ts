/**
 * A deliberately tiny Slack Web API client — the ONLY place an HTTP request to
 * Slack is made, and it can reach exactly one, fixed endpoint.
 *
 * This is not a generic HTTP layer: the URL is a constant, the method is fixed, and
 * the only operation is `chat.postMessage`. A caller cannot point it at an arbitrary
 * URL, choose a method, or supply a raw request body. That confinement is the whole
 * reason it exists as its own seam.
 *
 * The transport is an interface so the connector can be unit-tested with a fake that
 * records the request and returns scripted responses — the normal test suite never
 * touches the network. The default implementation uses Node's global `fetch`.
 */

/** The one Slack method this step supports. */
const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';

/** The validated arguments a post needs. No token here — that is passed separately. */
export interface SlackPostMessageInput {
  readonly channel: string;
  readonly text: string;
}

/** Slack's JSON body for chat.postMessage — only the fields we read. */
export interface SlackPostMessageBody {
  readonly ok: boolean;
  readonly error?: string;
  readonly channel?: string;
  readonly ts?: string;
  /** Slack may echo `warning`; kept for safe diagnostics only, never a secret. */
  readonly warning?: string;
}

/** A normalized HTTP outcome the connector interprets. Never carries the token. */
export interface SlackHttpResponse {
  readonly status: number;
  /** Parsed `Retry-After` (seconds) when Slack rate-limits us. */
  readonly retryAfterSeconds?: number;
  readonly body: SlackPostMessageBody;
}

/**
 * The seam the connector depends on. `postMessage` performs the single Slack call.
 * It resolves with a {@link SlackHttpResponse} for any HTTP response (including 4xx/
 * 5xx/429) and rejects only for a transport-level failure (network/timeout/abort).
 */
export interface SlackTransport {
  postMessage(input: SlackPostMessageInput, botToken: string): Promise<SlackHttpResponse>;
}

/** The `fetch` surface we use, so a test can inject a stub without DOM types. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchSlackTransportOptions {
  /** Injectable fetch (defaults to the global). */
  readonly fetch?: FetchLike;
  /** Per-request timeout in ms (defaults to 10s). Guards a hung Slack call. */
  readonly timeoutMs?: number;
}

/**
 * The real transport: POSTs form-encoded params to the fixed Slack URL with the bot
 * token in the Authorization header (never in the body, never logged). A timeout
 * aborts a hung request so it surfaces as a retryable transport failure.
 */
export function createFetchSlackTransport(options: FetchSlackTransportOptions = {}): SlackTransport {
  const fetchFn: FetchLike = options.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async postMessage(input: SlackPostMessageInput, botToken: string): Promise<SlackHttpResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const params = new URLSearchParams({ channel: input.channel, text: input.text });
        const response = await fetchFn(SLACK_POST_MESSAGE_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${botToken}`,
            'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
          },
          body: params.toString(),
          signal: controller.signal,
        });

        const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
        const body = (await response.json().catch(() => ({ ok: false, error: 'invalid_response' }))) as SlackPostMessageBody;
        return {
          status: response.status,
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
          body,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Parse a `Retry-After` header (integer seconds) into a number, or undefined. */
function parseRetryAfter(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
