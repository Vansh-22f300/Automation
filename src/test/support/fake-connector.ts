/**
 * A dummy connector + connection resolver for tests only.
 *
 * The generic tool layer ships NO concrete connector (Step 9A builds the
 * architecture, not Slack/Gmail/GitHub). But the executor and registry need
 * *something* to exercise. These fakes satisfy the exact contracts the real layer
 * depends on — a {@link Connector} and a {@link ConnectionResolver} — without any
 * network call, and record enough to prove the security ordering:
 *
 *   - {@link FakeConnector} counts executions and captures the last request, so a
 *     test can assert it was NOT called when arguments were invalid or the
 *     connection was refused, and that it received validated args + the resolved
 *     credential.
 *   - {@link FakeConnectionResolver} records the order of operations relative to the
 *     connector (via a shared call log) and can be scripted to throw the
 *     missing/disabled errors a real repository would.
 */

import type {
  AuthorizedConnection,
  ConnectionRef,
  ConnectionResolver,
} from '@/domain/connection.js';
import type { Connector, ConnectorRequest } from '@/domain/tool.js';

/** A shared, ordered log so tests can assert "resolve happened before execute". */
export type CallLog = string[];

export interface FakeConnectorOptions {
  readonly provider?: string;
  /** What `execute` returns. Defaults to a small non-secret object. */
  readonly output?: unknown;
  /** If set, `execute` rejects with this instead of returning. */
  readonly failWith?: Error;
  /** Shared call log to append `"execute"` to. */
  readonly log?: CallLog;
}

export class FakeConnector implements Connector {
  readonly provider: string;
  executeCalls = 0;
  lastRequest: ConnectorRequest | undefined;

  private readonly output: unknown;
  private readonly failWith: Error | undefined;
  private readonly log: CallLog | undefined;

  constructor(options: FakeConnectorOptions = {}) {
    this.provider = options.provider ?? 'test-provider';
    this.output = options.output ?? { ok: true };
    this.failWith = options.failWith;
    this.log = options.log;
  }

  execute(request: ConnectorRequest): Promise<unknown> {
    this.executeCalls += 1;
    this.lastRequest = request;
    this.log?.push('execute');
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve(this.output);
  }
}

export interface FakeConnectionResolverOptions {
  /** The connection returned by `resolveForTool`. */
  readonly connection?: AuthorizedConnection;
  /** If set, `resolveForTool` rejects with this instead of returning. */
  readonly failWith?: Error;
  /** Shared call log to append `"resolve"` to. */
  readonly log?: CallLog;
}

export class FakeConnectionResolver implements ConnectionResolver {
  resolveCalls = 0;
  lastRef: ConnectionRef | undefined;

  private readonly connection: AuthorizedConnection;
  private readonly failWith: Error | undefined;
  private readonly log: CallLog | undefined;

  constructor(options: FakeConnectionResolverOptions = {}) {
    this.connection = options.connection ?? {
      metadata: {
        id: 'conn-1',
        provider: 'test-provider',
        name: 'test',
        status: 'active',
        metadata: {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
        lastUsedAt: null,
      },
      credential: { token: 'super-secret-token' },
    };
    this.failWith = options.failWith;
    this.log = options.log;
  }

  resolveForTool(ref: ConnectionRef): Promise<AuthorizedConnection> {
    this.resolveCalls += 1;
    this.lastRef = ref;
    this.log?.push('resolve');
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve(this.connection);
  }
}
