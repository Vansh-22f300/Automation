/**
 * Unit tests for the declarative output-schema format used by `llm` steps.
 *
 * Two responsibilities are proven here, both pure (no database, no model):
 *   - `outputSchemaSchema` accepts the supported subset and rejects everything
 *     outside it (unknown type, unsupported JSON-Schema construct, references
 *     smuggled into schema text, a required name that is not a declared property);
 *   - `compileOutputSchema` turns a validated declarative schema into a Zod schema
 *     that accepts conforming data, rejects non-conforming data, drives optionality
 *     from `required`, and strips undeclared keys before data reaches context.
 */

import { describe, expect, it } from 'vitest';

import { compileOutputSchema, outputSchemaSchema } from '@/domain/output-schema.js';

describe('outputSchemaSchema (declarative validation)', () => {
  it('accepts the supported subset', () => {
    const result = outputSchemaSchema.safeParse({
      type: 'object',
      properties: {
        category: { type: 'enum', values: ['spam', 'ham'] },
        score: { type: 'number', description: 'confidence 0..1' },
        flagged: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        nested: {
          type: 'object',
          properties: { note: { type: 'string' } },
        },
      },
      required: ['category'],
    });
    expect(result.success).toBe(true);
  });

  it('requires the root to be an object', () => {
    expect(outputSchemaSchema.safeParse({ type: 'string' }).success).toBe(false);
  });

  it('rejects an unknown node type', () => {
    expect(
      outputSchemaSchema.safeParse({
        type: 'object',
        properties: { x: { type: 'integer' } },
      }).success,
    ).toBe(false);
  });

  it('rejects unsupported JSON-Schema constructs (extra keys)', () => {
    expect(
      outputSchemaSchema.safeParse({
        type: 'object',
        properties: { x: { type: 'string', pattern: '^a' } },
      }).success,
    ).toBe(false);
    expect(
      outputSchemaSchema.safeParse({
        type: 'object',
        properties: { x: { $ref: '#/definitions/y' } },
      }).success,
    ).toBe(false);
  });

  it('rejects a reference token in schema text', () => {
    expect(
      outputSchemaSchema.safeParse({
        type: 'object',
        properties: { x: { type: 'string', description: 'echo {{trigger.payload.x}}' } },
      }).success,
    ).toBe(false);
  });

  it('rejects an empty enum', () => {
    expect(
      outputSchemaSchema.safeParse({
        type: 'object',
        properties: { x: { type: 'enum', values: [] } },
      }).success,
    ).toBe(false);
  });

  it('rejects a required name that is not a declared property', () => {
    expect(
      outputSchemaSchema.safeParse({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a', 'ghost'],
      }).success,
    ).toBe(false);
  });
});

describe('compileOutputSchema (declarative → Zod)', () => {
  const declarative = outputSchemaSchema.parse({
    type: 'object',
    properties: {
      category: { type: 'enum', values: ['spam', 'ham'] },
      score: { type: 'number' },
      optionalNote: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['category', 'score'],
  });

  it('accepts conforming data and preserves declared fields', () => {
    const zodSchema = compileOutputSchema(declarative);
    const parsed = zodSchema.parse({ category: 'spam', score: 0.9, tags: ['x'] });
    expect(parsed).toEqual({ category: 'spam', score: 0.9, tags: ['x'] });
  });

  it('rejects data missing a required field', () => {
    const zodSchema = compileOutputSchema(declarative);
    expect(zodSchema.safeParse({ category: 'spam' }).success).toBe(false);
  });

  it('rejects a value outside an enum', () => {
    const zodSchema = compileOutputSchema(declarative);
    expect(zodSchema.safeParse({ category: 'other', score: 1 }).success).toBe(false);
  });

  it('rejects a wrong scalar type', () => {
    const zodSchema = compileOutputSchema(declarative);
    expect(zodSchema.safeParse({ category: 'ham', score: 'high' }).success).toBe(false);
  });

  it('treats non-required fields as optional', () => {
    const zodSchema = compileOutputSchema(declarative);
    const parsed = zodSchema.parse({ category: 'ham', score: 0.1 });
    expect(parsed).toEqual({ category: 'ham', score: 0.1 });
  });

  it('strips undeclared keys before data reaches context', () => {
    const zodSchema = compileOutputSchema(declarative);
    const parsed = zodSchema.parse({ category: 'spam', score: 0.5, injected: 'nope' }) as Record<
      string,
      unknown
    >;
    expect(parsed.injected).toBeUndefined();
    expect('injected' in parsed).toBe(false);
  });
});
