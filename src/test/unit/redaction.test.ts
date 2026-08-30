/**
 * Unit tests for the redaction policy — pure, no database.
 *
 * These pin the guarantees the inspection surfaces rely on: a stored error is
 * stripped to `{code, message, retryable?}`; a value summary reports the true size
 * but caps and scrubs the preview; the secret patterns catch the high-confidence
 * shapes; and the deep scrub elides secret-named keys without mutating its input.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_PREVIEW_CHARS,
  redactDeep,
  redactSecrets,
  summarizeValue,
  toSafeError,
} from '@/domain/redaction.js';

describe('toSafeError', () => {
  it('keeps only code, message and retryable', () => {
    const safe = toSafeError({
      code: 'boom',
      message: 'it failed',
      retryable: true,
      details: { secret: 'do-not-leak' },
      stack: 'Error: at ...',
    });
    expect(safe).toEqual({ code: 'boom', message: 'it failed', retryable: true });
  });

  it('omits retryable when absent and defaults a missing code/message', () => {
    expect(toSafeError({})).toEqual({ code: 'unknown_error', message: 'An error occurred' });
  });

  it('returns null for null/undefined/non-object', () => {
    expect(toSafeError(null)).toBeNull();
    expect(toSafeError(undefined)).toBeNull();
    expect(toSafeError('nope')).toBeNull();
  });

  it('redacts secrets that appear in the message', () => {
    const safe = toSafeError({ code: 'x', message: 'used Bearer abc.def.ghi to call' });
    expect(safe?.message).toContain('«redacted:bearer»');
    expect(safe?.message).not.toContain('abc.def.ghi');
  });
});

describe('redactSecrets', () => {
  it('redacts bearer tokens, slack tokens, api keys and long hex', () => {
    expect(redactSecrets('Authorization: Bearer eyJ.abc-123')).toContain('«redacted:bearer»');
    expect(redactSecrets('xoxb-123-456-abc')).toContain('«redacted:slack-token»');
    expect(redactSecrets('sk-ant-0123456789abcdefXYZ')).toContain('«redacted:api-key»');
    expect(redactSecrets('a'.repeat(40))).toContain('«redacted:hex-secret»');
  });

  it('redacts values of secret-named JSON keys', () => {
    const out = redactSecrets('{"password":"hunter2","user":"bob"}');
    expect(out).toContain('«redacted:secret-key»');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('bob');
  });

  it('leaves benign text untouched', () => {
    expect(redactSecrets('hello world 123')).toBe('hello world 123');
  });
});

describe('summarizeValue', () => {
  it('reports true byte size and does not truncate a small value', () => {
    const s = summarizeValue({ a: 1 });
    expect(s.truncated).toBe(false);
    expect(s.preview).toBe('{"a":1}');
    expect(s.bytes).toBe(Buffer.byteLength('{"a":1}', 'utf8'));
  });

  it('truncates a value longer than the cap and still reports full size', () => {
    const big = 'x'.repeat(MAX_PREVIEW_CHARS + 100);
    const s = summarizeValue(big);
    expect(s.truncated).toBe(true);
    expect(s.preview).toContain('(truncated');
    // Full JSON is the string plus its two quote characters.
    expect(s.bytes).toBe(big.length + 2);
  });

  it('does not truncate exactly at the cap boundary', () => {
    // JSON encoding adds two quotes, so a raw length of cap-2 lands exactly at cap.
    const atCap = 'y'.repeat(MAX_PREVIEW_CHARS - 2);
    const s = summarizeValue(atCap);
    expect(s.truncated).toBe(false);
  });

  it('redacts secrets inside the preview', () => {
    const s = summarizeValue({ token: 'super-secret-value' });
    expect(s.preview).toContain('«redacted:secret-key»');
    expect(s.preview).not.toContain('super-secret-value');
  });
});

describe('redactDeep', () => {
  it('elides secret-named keys and scrubs strings, without mutating input', () => {
    const input = { password: 'p', note: 'call Bearer abc.def', nested: { api_key: 'k', ok: 1 } };
    const out = redactDeep(input) as Record<string, unknown>;
    expect(out.password).toBe('«redacted:secret-key»');
    expect(out.note).toContain('«redacted:bearer»');
    expect((out.nested as Record<string, unknown>).api_key).toBe('«redacted:secret-key»');
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
    // Input untouched.
    expect(input.password).toBe('p');
  });

  it('stops at the depth bound', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 15; i += 1) deep = { next: deep };
    const out = JSON.stringify(redactDeep(deep));
    expect(out).toContain('«redacted:depth»');
  });
});
