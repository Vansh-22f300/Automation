/**
 * Tool executor unit tests: the security ordering is the contract.
 *
 * These assert, with fakes, the exact sequence item 10 of the spec requires —
 * resolve tool → validate args → authorize/resolve connection → decrypt → execute →
 * normalize — and, critically, that a failure at an earlier gate prevents every
 * later one (invalid args ⇒ connection never resolved ⇒ connector never called),
 * and that the credential never leaks into a result or the logger.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { PermanentError, RetryableError } from '@/domain/errors.js';
import type {
  EffectAcquisition,
  EffectFailureDisposition,
  EffectLedger,
  EffectReservation,
} from '@/domain/effect-ledger.js';
import { MissingConnectionError } from '@/domain/tool-errors.js';
import { ToolExecutor } from '@/domain/tool-executor.js';
import { ToolRegistry } from '@/domain/tool-registry.js';
import { EFFECT_SAFETY_DETAIL_KEY } from '@/domain/tool.js';
import type { ToolCall, ToolContext, ToolDefinition } from '@/domain/tool.js';
import { FakeConnectionResolver, FakeConnector } from '@/test/support/fake-connector.js';

const CONTEXT: ToolContext = { tenantId: 't1', runId: 'r1', stepRunId: 's1', toolName: 'send' };

function build(options: {
  connector?: FakeConnector;
  resolver?: FakeConnectionResolver;
} = {}) {
  const connector = options.connector ?? new FakeConnector({ provider: 'test-provider', output: { delivered: true } });
  const definition: ToolDefinition = {
    name: 'send',
    description: 'send a message',
    provider: 'test-provider',
    inputSchema: z.object({ text: z.string() }).strict(),
    connector,
  };
  const registry = new ToolRegistry().register(definition);
  const resolver = options.resolver ?? new FakeConnectionResolver();
  return { executor: new ToolExecutor(registry, resolver), connector, resolver };
}

const call = (args: unknown): ToolCall => ({ id: 'call-1', name: 'send', arguments: args });

describe('ToolExecutor success', () => {
  it('resolves, validates, resolves connection, executes, and normalizes', async () => {
    const log: string[] = [];
    const connector = new FakeConnector({ provider: 'test-provider', output: { delivered: true }, log });
    const resolver = new FakeConnectionResolver({ log });
    const { executor } = build({ connector, resolver });

    const result = await executor.execute(call({ text: 'hi' }), {
      context: CONTEXT,
      connectionRef: { provider: 'test-provider' },
    });

    expect(result).toEqual({ id: 'call-1', name: 'send', success: true, output: { delivered: true } });
    // Order: connection resolution strictly before connector execution.
    expect(log).toEqual(['resolve', 'execute']);
    // Connector received the validated args and the resolved credential.
    expect(connector.lastRequest?.arguments).toEqual({ text: 'hi' });
    expect(connector.lastRequest?.connection.credential).toEqual({ token: 'super-secret-token' });
  });
});

describe('ToolExecutor argument validation precedes everything external', () => {
  it('fails invalid args before resolving a connection or calling the connector', async () => {
    const { executor, connector, resolver } = build();

    const result = await executor.execute(call({ text: 123 }), {
      context: CONTEXT,
      connectionRef: { provider: 'test-provider' },
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('invalid_tool_arguments');
    expect(resolver.resolveCalls).toBe(0);
    expect(connector.executeCalls).toBe(0);
  });

  it('rejects unknown fields (strict schema)', async () => {
    const { executor, connector, resolver } = build();
    const result = await executor.execute(call({ text: 'hi', extra: 'x' }), {
      context: CONTEXT,
      connectionRef: { provider: 'test-provider' },
    });
    expect(result.error?.code).toBe('invalid_tool_arguments');
    expect(resolver.resolveCalls).toBe(0);
    expect(connector.executeCalls).toBe(0);
  });
});

describe('ToolExecutor connection gating', () => {
  it('normalizes an unknown tool to a result, never touching a connection', async () => {
    const { executor, resolver } = build();
    const result = await executor.execute(
      { id: 'c', name: 'nope', arguments: {} },
      { context: { ...CONTEXT, toolName: 'nope' }, connectionRef: { provider: 'test-provider' } },
    );
    expect(result.error?.code).toBe('unknown_tool');
    expect(resolver.resolveCalls).toBe(0);
  });

  it('refuses a provider mismatch before resolving/executing', async () => {
    const { executor, connector, resolver } = build();
    const result = await executor.execute(call({ text: 'hi' }), {
      context: CONTEXT,
      connectionRef: { provider: 'other-provider' },
    });
    expect(result.error?.code).toBe('unauthorized_connection');
    expect(resolver.resolveCalls).toBe(0);
    expect(connector.executeCalls).toBe(0);
  });

  it('requires a connection reference', async () => {
    const { executor, connector } = build();
    const result = await executor.execute(call({ text: 'hi' }), { context: CONTEXT });
    expect(result.error?.code).toBe('unauthorized_connection');
    expect(connector.executeCalls).toBe(0);
  });

  it('surfaces a missing connection and never calls the connector', async () => {
    const resolver = new FakeConnectionResolver({
      failWith: new MissingConnectionError({ provider: 'test-provider' }),
    });
    const { executor, connector } = build({ resolver });
    const result = await executor.execute(call({ text: 'hi' }), {
      context: CONTEXT,
      connectionRef: { provider: 'test-provider' },
    });
    expect(result.error?.code).toBe('missing_connection');
    expect(connector.executeCalls).toBe(0);
  });
});

describe('ToolExecutor trusted connection reference', () => {
  // A tool schema that deliberately permits a `connectionId`-looking field in the
  // model's arguments, to prove the executor still IGNORES it and uses only the
  // trusted connectionRef from options.
  function buildSelectable(resolver: FakeConnectionResolver) {
    const connector = new FakeConnector({ provider: 'test-provider', output: { ok: true } });
    const definition: ToolDefinition = {
      name: 'send',
      description: 'send a message',
      provider: 'test-provider',
      inputSchema: z
        .object({ text: z.string(), connectionId: z.string().optional(), tenantId: z.string().optional() })
        .strict(),
      connector,
    };
    const registry = new ToolRegistry().register(definition);
    return { executor: new ToolExecutor(registry, resolver), connector };
  }

  it('resolves exactly the trusted connectionRef, never a model-supplied selector', async () => {
    const resolver = new FakeConnectionResolver();
    const { executor, connector } = buildSelectable(resolver);

    // The model tries to smuggle its own connection/tenant through arguments.
    const result = await executor.execute(
      call({ text: 'hi', connectionId: 'attacker-chosen', tenantId: 'victim-tenant' }),
      { context: CONTEXT, connectionRef: { provider: 'test-provider', connectionId: 'trusted-conn' } },
    );

    expect(result.success).toBe(true);
    // The resolver saw ONLY the trusted ref — the model's connectionId/tenantId are ignored.
    expect(resolver.lastRef).toEqual({ provider: 'test-provider', connectionId: 'trusted-conn' });
    // The connector received the resolver's connection, not anything the model named.
    expect(connector.lastRequest?.connection.metadata.id).toBe('conn-1');
  });
});

describe('ToolExecutor failure normalization & secret hygiene', () => {
  it('classifies a connector failure and carries its retryable flag', async () => {
    const connector = new FakeConnector({
      provider: 'test-provider',
      failWith: new PermanentError('connector_failure', 'upstream said no'),
    });
    const { executor } = build({ connector });
    const result = await executor.execute(call({ text: 'hi' }), {
      context: CONTEXT,
      connectionRef: { provider: 'test-provider' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toEqual({ code: 'connector_failure', message: 'upstream said no', retryable: false });
  });

  it('never leaks the credential into the result or the logger', async () => {
    const info = vi.fn();
    const warn = vi.fn();
    const logger = { info, warn, error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never;
    const { executor } = build();

    const result = await executor.execute(call({ text: 'hi' }), {
      context: CONTEXT,
      connectionRef: { provider: 'test-provider' },
      logger,
    });

    const serialized = JSON.stringify({ result, calls: info.mock.calls.concat(warn.mock.calls) });
    expect(serialized).not.toContain('super-secret-token');
  });
});

/**
 * A scripted {@link EffectLedger} for the executor's ledger-branch tests. It returns
 * a pre-set {@link EffectAcquisition} from `acquire` and records the disposition of
 * any `settleFailure` / the result of any `settleSuccess`, so a test can assert BOTH
 * how the executor reacted to each acquisition outcome AND how it settled after
 * running the connector — without a database.
 */
class FakeEffectLedger implements EffectLedger {
  acquireCalls = 0;
  settledSuccess: unknown = undefined;
  settledFailure: EffectFailureDisposition | undefined;
  successCalls = 0;
  failureCalls = 0;
  lastReservation: EffectReservation | undefined;

  constructor(private readonly acquisition: EffectAcquisition) {}

  acquire(reservation: EffectReservation): Promise<EffectAcquisition> {
    this.acquireCalls += 1;
    this.lastReservation = reservation;
    return Promise.resolve(this.acquisition);
  }

  settleSuccess(_reservation: EffectReservation, result: unknown): Promise<void> {
    this.successCalls += 1;
    this.settledSuccess = result;
    return Promise.resolve();
  }

  settleFailure(_reservation: EffectReservation, disposition: EffectFailureDisposition): Promise<void> {
    this.failureCalls += 1;
    this.settledFailure = disposition;
    return Promise.resolve();
  }
}

/** Build an executor wired with a scripted ledger, returning the moving parts. */
function buildLedgered(options: {
  acquisition: EffectAcquisition;
  connector?: FakeConnector;
}) {
  const connector = options.connector ?? new FakeConnector({ provider: 'test-provider', output: { delivered: true } });
  const definition: ToolDefinition = {
    name: 'send',
    description: 'send a message',
    provider: 'test-provider',
    inputSchema: z.object({ text: z.string() }).strict(),
    connector,
  };
  const registry = new ToolRegistry().register(definition);
  const resolver = new FakeConnectionResolver();
  const ledger = new FakeEffectLedger(options.acquisition);
  return { executor: new ToolExecutor(registry, resolver, ledger), connector, ledger };
}

/** The effect metadata the step handler injects for a ledgered call. */
const EFFECT_CONTEXT: ToolContext = {
  ...CONTEXT,
  metadata: { idempotencyKey: 'r1:step-1:send:1', ordinal: 1, stepKey: 'step-1', effectLeaseMs: 120_000 },
};

describe('ToolExecutor effect ledger — not ledgered', () => {
  it('calls the connector directly when a ledger is wired but no effect metadata is present', async () => {
    // No metadata on the context ⇒ pre-ledger behaviour: the connector runs, the
    // ledger is never consulted.
    const { executor, connector, ledger } = buildLedgered({ acquisition: { kind: 'acquired' } });
    const result = await executor.execute(call({ text: 'hi' }), {
      context: CONTEXT,
      connectionRef: { provider: 'test-provider' },
    });
    expect(result.success).toBe(true);
    expect(connector.executeCalls).toBe(1);
    expect(ledger.acquireCalls).toBe(0);
  });
});

describe('ToolExecutor effect ledger — acquisition branches', () => {
  it('acquired: runs the connector once and settles success with its output', async () => {
    const { executor, connector, ledger } = buildLedgered({ acquisition: { kind: 'acquired' } });
    const result = await executor.execute(call({ text: 'hi' }), {
      context: EFFECT_CONTEXT,
      connectionRef: { provider: 'test-provider' },
    });
    expect(result).toEqual({ id: 'call-1', name: 'send', success: true, output: { delivered: true } });
    expect(connector.executeCalls).toBe(1);
    expect(ledger.successCalls).toBe(1);
    expect(ledger.settledSuccess).toEqual({ delivered: true });
    // The reservation carried the trusted, non-model-controlled key.
    expect(ledger.lastReservation?.idempotencyKey).toBe('r1:step-1:send:1');
  });

  it('replay: returns the stored result and NEVER calls the connector', async () => {
    const { executor, connector, ledger } = buildLedgered({
      acquisition: { kind: 'replay', result: { delivered: true, replayed: true } },
    });
    const result = await executor.execute(call({ text: 'hi' }), {
      context: EFFECT_CONTEXT,
      connectionRef: { provider: 'test-provider' },
    });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ delivered: true, replayed: true });
    expect(connector.executeCalls).toBe(0);
    expect(ledger.successCalls).toBe(0);
  });

  it('failed: re-throws a permanent error, normalized to a result, no connector call', async () => {
    const { executor, connector } = buildLedgered({
      acquisition: { kind: 'failed', error: { code: 'slack_bad_request', message: 'bad channel', retryable: false } },
    });
    const result = await executor.execute(call({ text: 'hi' }), {
      context: EFFECT_CONTEXT,
      connectionRef: { provider: 'test-provider' },
    });
    expect(result.success).toBe(false);
    expect(result.error?.retryable).toBe(false);
    expect(connector.executeCalls).toBe(0);
  });

  it('ambiguous: surfaces as a non-retryable effect_ambiguous result, no connector call', async () => {
    const { executor, connector } = buildLedgered({
      acquisition: { kind: 'ambiguous', error: { code: 'effect_owner_lease_expired', message: 'crashed', retryable: false } },
    });
    const result = await executor.execute(call({ text: 'hi' }), {
      context: EFFECT_CONTEXT,
      connectionRef: { provider: 'test-provider' },
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('effect_ambiguous');
    expect(result.error?.retryable).toBe(false);
    expect(connector.executeCalls).toBe(0);
  });

  it('defer: surfaces a retryable result carrying the reschedule hint, no connector call', async () => {
    const { executor, connector } = buildLedgered({
      acquisition: { kind: 'defer', retryAfterMs: 123_000 },
    });
    const result = await executor.execute(call({ text: 'hi' }), {
      context: EFFECT_CONTEXT,
      connectionRef: { provider: 'test-provider' },
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('effect_pending_elsewhere');
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.retryAfterMs).toBe(123_000);
    expect(connector.executeCalls).toBe(0);
  });
});

describe('ToolExecutor effect ledger — settlement after an owned connector call', () => {
  it('SAFE retryable failure: settles release and re-throws the original retryable error', async () => {
    const connector = new FakeConnector({
      provider: 'test-provider',
      failWith: new RetryableError('slack_rate_limited', 'rate limited', {
        details: { [EFFECT_SAFETY_DETAIL_KEY]: 'safe' },
      }),
    });
    const { executor, ledger } = buildLedgered({ acquisition: { kind: 'acquired' }, connector });
    const result = await executor.execute(call({ text: 'hi' }), {
      context: EFFECT_CONTEXT,
      connectionRef: { provider: 'test-provider' },
    });
    expect(connector.executeCalls).toBe(1);
    expect(ledger.settledFailure?.kind).toBe('release');
    // The queue must still see the original retryable classification.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('slack_rate_limited');
    expect(result.error?.retryable).toBe(true);
  });

  it('AMBIGUOUS retryable failure: settles ambiguous and surfaces as non-retryable effect_ambiguous', async () => {
    const connector = new FakeConnector({
      provider: 'test-provider',
      failWith: new RetryableError('slack_5xx', 'server error', {
        details: { [EFFECT_SAFETY_DETAIL_KEY]: 'ambiguous', status: 503 },
      }),
    });
    const { executor, ledger } = buildLedgered({ acquisition: { kind: 'acquired' }, connector });
    const result = await executor.execute(call({ text: 'hi' }), {
      context: EFFECT_CONTEXT,
      connectionRef: { provider: 'test-provider' },
    });
    expect(connector.executeCalls).toBe(1);
    expect(ledger.settledFailure?.kind).toBe('ambiguous');
    // A retryable connector error is DOWNGRADED to permanent so the effect is never resent.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('effect_ambiguous');
    expect(result.error?.retryable).toBe(false);
  });

  it('permanent failure: settles failed and re-throws the original permanent error', async () => {
    const connector = new FakeConnector({
      provider: 'test-provider',
      failWith: new PermanentError('slack_bad_request', 'invalid channel'),
    });
    const { executor, ledger } = buildLedgered({ acquisition: { kind: 'acquired' }, connector });
    const result = await executor.execute(call({ text: 'hi' }), {
      context: EFFECT_CONTEXT,
      connectionRef: { provider: 'test-provider' },
    });
    expect(connector.executeCalls).toBe(1);
    expect(ledger.settledFailure?.kind).toBe('permanent');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('slack_bad_request');
    expect(result.error?.retryable).toBe(false);
  });
});
