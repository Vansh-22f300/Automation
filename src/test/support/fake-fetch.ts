/**
 * A fake `fetch` for tests. Records every call (url + init) and resolves a
 * scripted {@link Response} — or rejects with a scripted error to simulate a
 * network/timeout failure. Mirrors {@link FakeSlackTransport}: the test suite
 * MUST NOT reach the real Resend API, and this is how the Resend email-sender
 * tests exercise the transport without a provider account or key.
 *
 * It also lets a test assert exactly what reached the wire (endpoint, method,
 * Authorization header, JSON body) and — by never logging — that the injected
 * key travels only in the request it is handed.
 */

import type { FetchLike } from '@/auth/email/resend-email-sender.js';

/** One recorded request. `init` is the exact object the sender passed. */
export interface FakeFetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

export interface FakeFetchOptions {
  /** HTTP status to resolve with. Defaults to 200 (success). */
  readonly status?: number;
  /** Response body; objects are JSON-serialized. Defaults to `{ id: '…' }`. */
  readonly body?: unknown;
  /** If set, the fetch REJECTS with this instead of resolving (network/timeout). */
  readonly throwError?: Error;
}

export class FakeFetch {
  readonly calls: FakeFetchCall[] = [];

  private readonly status: number;
  private readonly body: unknown;
  private readonly throwError: Error | undefined;

  constructor(options: FakeFetchOptions = {}) {
    this.status = options.status ?? 200;
    this.body = options.body ?? { id: 'test-message-id' };
    this.throwError = options.throwError;
  }

  /** The injectable {@link FetchLike}; bound so it can be passed by reference. */
  readonly fetch: FetchLike = (url, init) => {
    this.calls.push({ url, init });
    if (this.throwError !== undefined) return Promise.reject(this.throwError);
    const payload = typeof this.body === 'string' ? this.body : JSON.stringify(this.body);
    return Promise.resolve(
      new Response(payload, {
        status: this.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  get lastCall(): FakeFetchCall | undefined {
    return this.calls.at(-1);
  }
}
