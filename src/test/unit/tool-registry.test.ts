/**
 * Tool registry unit tests: registration, duplicate rejection, unknown rejection,
 * and metadata-only, deterministic listing.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FakeConnector } from '@/test/support/fake-connector.js';
import { DuplicateToolRegistrationError, UnknownToolError } from '@/domain/tool-errors.js';
import { ToolRegistry } from '@/domain/tool-registry.js';
import type { ToolDefinition } from '@/domain/tool.js';

function tool(name: string, provider = 'test-provider'): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    provider,
    inputSchema: z.object({ text: z.string() }).strict(),
    connector: new FakeConnector({ provider }),
  };
}

describe('ToolRegistry', () => {
  it('registers and resolves a tool', () => {
    const registry = new ToolRegistry().register(tool('send'));
    expect(registry.has('send')).toBe(true);
    expect(registry.resolve('send').name).toBe('send');
  });

  it('rejects a duplicate registration', () => {
    const registry = new ToolRegistry().register(tool('send'));
    expect(() => registry.register(tool('send'))).toThrow(DuplicateToolRegistrationError);
  });

  it('rejects resolving an unknown tool', () => {
    const registry = new ToolRegistry();
    expect(() => registry.resolve('nope')).toThrow(UnknownToolError);
    expect(registry.has('nope')).toBe(false);
  });

  it('lists metadata only, sorted by name, exposing no connector or secret', () => {
    const registry = new ToolRegistry()
      .register(tool('zebra', 'p2'))
      .register(tool('alpha', 'p1'));
    const list = registry.list();
    expect(list.map((t) => t.name)).toEqual(['alpha', 'zebra']);
    expect(list[0]).toEqual({ name: 'alpha', description: 'alpha description', provider: 'p1' });
    // Metadata carries no connector/schema fields.
    expect(Object.keys(list[0]!).sort()).toEqual(['description', 'name', 'provider']);
  });
});
