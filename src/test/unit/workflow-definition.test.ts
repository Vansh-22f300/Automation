/**
 * Unit tests for the workflow-definition schema.
 *
 * Pure validation, no database. These pin down exactly which documents the schema
 * accepts and — just as important — which it rejects, so that the one contract
 * shared by manual creation, version creation and future AI generation cannot
 * drift silently.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFINITION_SCHEMA_VERSION,
  parseWorkflowDefinition,
  workflowDefinitionSchema,
} from '@/domain/workflow-definition.js';

/** A minimal, valid linear noop definition. */
const validDefinition = {
  version: DEFINITION_SCHEMA_VERSION,
  steps: [
    { key: 'first', type: 'noop', config: {} },
    { key: 'second', type: 'noop', config: {} },
  ],
};

describe('workflowDefinitionSchema', () => {
  it('accepts a valid linear noop workflow', () => {
    const parsed = parseWorkflowDefinition(validDefinition);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[0]!.type).toBe('noop');
  });

  it('defaults an omitted step config to an empty object', () => {
    const parsed = parseWorkflowDefinition({
      version: DEFINITION_SCHEMA_VERSION,
      steps: [{ key: 'only', type: 'noop' }],
    });
    expect(parsed.steps[0]!.config).toEqual({});
  });

  it('rejects an empty step list', () => {
    expect(() =>
      parseWorkflowDefinition({ version: DEFINITION_SCHEMA_VERSION, steps: [] }),
    ).toThrow();
  });

  it('rejects duplicate step keys', () => {
    const result = workflowDefinitionSchema.safeParse({
      version: DEFINITION_SCHEMA_VERSION,
      steps: [
        { key: 'dup', type: 'noop', config: {} },
        { key: 'dup', type: 'noop', config: {} },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('duplicate step key'))).toBe(true);
    }
  });

  it('rejects an invalid step key format', () => {
    for (const key of ['Bad', '1st', 'has space', 'has-dash', '']) {
      expect(
        workflowDefinitionSchema.safeParse({
          version: DEFINITION_SCHEMA_VERSION,
          steps: [{ key, type: 'noop', config: {} }],
        }).success,
      ).toBe(false);
    }
  });

  it('rejects an unsupported step type', () => {
    expect(
      workflowDefinitionSchema.safeParse({
        version: DEFINITION_SCHEMA_VERSION,
        steps: [{ key: 'first', type: 'action', config: {} }],
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed step config (unknown keys)', () => {
    expect(
      workflowDefinitionSchema.safeParse({
        version: DEFINITION_SCHEMA_VERSION,
        steps: [{ key: 'first', type: 'noop', config: { unexpected: true } }],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown top-level fields', () => {
    expect(
      workflowDefinitionSchema.safeParse({
        version: DEFINITION_SCHEMA_VERSION,
        steps: [{ key: 'first', type: 'noop', config: {} }],
        extra: 'nope',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown schema version', () => {
    expect(
      workflowDefinitionSchema.safeParse({
        version: 2,
        steps: [{ key: 'first', type: 'noop', config: {} }],
      }).success,
    ).toBe(false);
  });
});

describe('workflowDefinitionSchema — llm steps', () => {
  /** A minimal, valid llm step config. */
  const validLlmConfig = {
    system: 'You are a classifier.',
    input: '{{trigger.payload.text}}',
    output_schema: {
      type: 'object',
      properties: {
        category: { type: 'enum', values: ['spam', 'ham'] },
        confidence: { type: 'number' },
      },
      required: ['category'],
    },
  };

  it('accepts a valid llm step', () => {
    const parsed = parseWorkflowDefinition({
      version: DEFINITION_SCHEMA_VERSION,
      steps: [{ key: 'classify', type: 'llm', config: validLlmConfig }],
    });
    expect(parsed.steps[0]!.type).toBe('llm');
    // max_output_tokens defaults when omitted.
    const config = parsed.steps[0]!.config as { max_output_tokens: number };
    expect(config.max_output_tokens).toBe(1024);
  });

  it('accepts an optional model override', () => {
    const parsed = parseWorkflowDefinition({
      version: DEFINITION_SCHEMA_VERSION,
      steps: [
        { key: 'classify', type: 'llm', config: { ...validLlmConfig, model: 'claude-x' } },
      ],
    });
    const config = parsed.steps[0]!.config as { model?: string };
    expect(config.model).toBe('claude-x');
  });

  it('rejects an llm step missing required config fields', () => {
    expect(
      workflowDefinitionSchema.safeParse({
        version: DEFINITION_SCHEMA_VERSION,
        steps: [{ key: 'classify', type: 'llm', config: {} }],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown keys in llm config', () => {
    expect(
      workflowDefinitionSchema.safeParse({
        version: DEFINITION_SCHEMA_VERSION,
        steps: [
          { key: 'classify', type: 'llm', config: { ...validLlmConfig, temperature: 0.7 } },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a template reference in the system instruction', () => {
    // The system instruction must be static/trusted; references belong only in `input`.
    expect(
      workflowDefinitionSchema.safeParse({
        version: DEFINITION_SCHEMA_VERSION,
        steps: [
          {
            key: 'classify',
            type: 'llm',
            config: { ...validLlmConfig, system: 'You are {{trigger.payload.role}}.' },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid output schema (missing root type)', () => {
    expect(
      workflowDefinitionSchema.safeParse({
        version: DEFINITION_SCHEMA_VERSION,
        steps: [
          {
            key: 'classify',
            type: 'llm',
            config: { ...validLlmConfig, output_schema: { properties: {} } },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects an unsupported output-schema construct', () => {
    expect(
      workflowDefinitionSchema.safeParse({
        version: DEFINITION_SCHEMA_VERSION,
        steps: [
          {
            key: 'classify',
            type: 'llm',
            config: {
              ...validLlmConfig,
              output_schema: {
                type: 'object',
                properties: { ref: { $ref: '#/definitions/thing' } },
              },
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a required name absent from properties', () => {
    expect(
      workflowDefinitionSchema.safeParse({
        version: DEFINITION_SCHEMA_VERSION,
        steps: [
          {
            key: 'classify',
            type: 'llm',
            config: {
              ...validLlmConfig,
              output_schema: {
                type: 'object',
                properties: { a: { type: 'string' } },
                required: ['a', 'missing'],
              },
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
