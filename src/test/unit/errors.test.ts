import { describe, expect, it } from 'vitest';
import {
  AppError,
  PermanentError,
  RetryableError,
  isAppError,
  isRetryable,
} from '@/domain/errors.js';

describe('RetryableError', () => {
  it('is flagged retryable and carries its code', () => {
    const error = new RetryableError('llm_timeout', 'Claude did not respond in time');

    expect(error.retryable).toBe(true);
    expect(error.code).toBe('llm_timeout');
    expect(error.message).toBe('Claude did not respond in time');
    expect(error.name).toBe('RetryableError');
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
  });

  it('preserves cause and details', () => {
    const cause = new Error('socket hang up');
    const error = new RetryableError('api_timeout', 'Slack timed out', {
      cause,
      details: { connector_id: 'slack', attempt: 2 },
    });

    expect(error.cause).toBe(cause);
    expect(error.details).toEqual({ connector_id: 'slack', attempt: 2 });
  });

  it('leaves details undefined when not supplied', () => {
    expect(new RetryableError('x', 'y').details).toBeUndefined();
  });
});

describe('PermanentError', () => {
  it('is flagged not retryable', () => {
    const error = new PermanentError('invalid_definition', 'Step "notify" has no connector');

    expect(error.retryable).toBe(false);
    expect(error.name).toBe('PermanentError');
    expect(error).toBeInstanceOf(AppError);
  });
});

describe('isAppError', () => {
  it('recognises our errors and rejects everything else', () => {
    expect(isAppError(new RetryableError('a', 'b'))).toBe(true);
    expect(isAppError(new PermanentError('a', 'b'))).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError('a string')).toBe(false);
    expect(isAppError(undefined)).toBe(false);
  });
});

describe('isRetryable', () => {
  it('is true only for RetryableError', () => {
    expect(isRetryable(new RetryableError('a', 'b'))).toBe(true);
    expect(isRetryable(new PermanentError('a', 'b'))).toBe(false);
  });

  it('defaults unclassified failures to not retryable', () => {
    expect(isRetryable(new Error('unexpected'))).toBe(false);
    expect(isRetryable('boom')).toBe(false);
    expect(isRetryable(null)).toBe(false);
  });
});
