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

import { PermanentError } from '@/domain/errors.js';
import { MissingConnectionError } from '@/domain/tool-errors.js';
import { ToolExecutor } from '@/domain/tool-executor.js';
import { ToolRegistry } from '@/domain/tool-registry.js';
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
