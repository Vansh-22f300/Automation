/**
 * Unit tests for OAuth error classification (`@/oauth/errors`) — state design §12.
 * A token endpoint is an external dependency whose raw body may carry provider
 * detail or credential fragments, so these pin two guards: `safeOAuthErrorCode`
 * lets only a strict RFC-6749-charset token through (everything else collapses to
 * `'unrecognized'`), and `classifyTokenEndpointError` sorts failures onto the
 * retryable/permanent split with a FIXED human message and a sanitised reason —
 * never the raw response.
 */

import { describe, expect, it } from 'vitest';

import { PermanentError, RetryableError } from '@/domain/errors.js';
import {
  OAuthProviderError,
  OAuthProviderUnavailableError,
  OAuthStateInvalidError,
  classifyTokenEndpointError,
  safeOAuthErrorCode,
} from '@/oauth/errors.js';

describe('safeOAuthErrorCode', () => {
  it('passes through a valid RFC-6749 error token', () => {
    for (const value of ['invalid_grant', 'invalid-client', 'a', `a${'b'.repeat(63)}`]) {
      expect(safeOAuthErrorCode(value)).toBe(value);
    }
  });

  it('collapses anything malformed, over-long, or non-string to "unrecognized"', () => {
    for (const value of [
      '', // empty
      'Invalid', // uppercase lead
      '1grant', // digit lead
      '_grant', // underscore lead
      `a${'b'.repeat(64)}`, // 65 chars
      'bad code', // space
      undefined,
      null,
      42,
      {},
    ]) {
      expect(safeOAuthErrorCode(value)).toBe('unrecognized');
    }
  });
});

describe('classifyTokenEndpointError', () => {
  it('maps 4xx (400/401) to a permanent, non-retryable provider error', () => {
    for (const status of [400, 401]) {
      const error = classifyTokenEndpointError({ status, errorCode: 'invalid_grant' });
      expect(error).toBeInstanceOf(OAuthProviderError);
      expect(error.message).toBe('the OAuth provider rejected the token request');
      expect(error.retryable).toBe(false);
      expect(error.details).toEqual({ reason: 'invalid_grant' });
    }
  });

  it('maps 429/5xx/no-status to a retryable "temporarily unavailable" error', () => {
    for (const status of [429, 500, 503, undefined]) {
      const error = classifyTokenEndpointError({ status });
      expect(error).toBeInstanceOf(OAuthProviderUnavailableError);
      expect(error.message).toBe('the OAuth provider is temporarily unavailable');
      expect(error.retryable).toBe(true);
    }
  });

  it('sanitises the provider reason (unsafe or missing → "unrecognized")', () => {
    expect(classifyTokenEndpointError({ status: 400, errorCode: 'BAD CODE!!' }).details).toEqual({
      reason: 'unrecognized',
    });
    expect(classifyTokenEndpointError({ status: 400 }).details).toEqual({ reason: 'unrecognized' });
  });
});

describe('the OAuth error classes', () => {
  it('OAuthProviderError is a permanent failure carrying its reason', () => {
    const error = new OAuthProviderError('rejected', 'invalid_grant');
    expect(error).toBeInstanceOf(PermanentError);
    expect(error.code).toBe('oauth_provider_error');
    expect(error.retryable).toBe(false);
    expect(error.details).toEqual({ reason: 'invalid_grant' });
  });

  it('OAuthProviderUnavailableError is a retryable failure carrying its reason', () => {
    const error = new OAuthProviderUnavailableError('down', 'network_error');
    expect(error).toBeInstanceOf(RetryableError);
    expect(error.code).toBe('oauth_provider_unavailable');
    expect(error.retryable).toBe(true);
    expect(error.details).toEqual({ reason: 'network_error' });
  });

  it('OAuthStateInvalidError is undifferentiated and permanent', () => {
    const error = new OAuthStateInvalidError();
    expect(error).toBeInstanceOf(PermanentError);
    expect(error.code).toBe('oauth_state_invalid');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('the OAuth state is missing, expired, already used, or mismatched');
  });
});
