/**
 * Unit tests for the trigger-configuration schema.
 *
 * Pure validation, no database. Only the `webhook` trigger exists, and its config
 * is a single safe `source` identifier.
 */

import { describe, expect, it } from 'vitest';

import { parseTriggerConfig, webhookTriggerConfigSchema } from '@/domain/workflow-trigger.js';

describe('webhookTriggerConfigSchema', () => {
  it('accepts a valid webhook source', () => {
    const parsed = parseTriggerConfig('webhook', { source: 'test' });
    expect(parsed.source).toBe('test');
  });

  it('accepts identifiers with digits, underscores and dashes', () => {
    for (const source of ['stripe', 'github', 'x_1', 'a-b-c']) {
      expect(webhookTriggerConfigSchema.safeParse({ source }).success).toBe(true);
    }
  });

  it('rejects a missing source', () => {
    expect(webhookTriggerConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty source', () => {
    expect(webhookTriggerConfigSchema.safeParse({ source: '' }).success).toBe(false);
  });

  it('rejects an unsafe source', () => {
    for (const source of ['Test', '1abc', 'has space', 'weird!', '-leading']) {
      expect(webhookTriggerConfigSchema.safeParse({ source }).success).toBe(false);
    }
  });

  it('rejects unknown config keys', () => {
    expect(
      webhookTriggerConfigSchema.safeParse({ source: 'test', extra: true }).success,
    ).toBe(false);
  });
});
