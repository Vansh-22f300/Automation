/**
 * Unit tests for the PUBLIC OAuth-callback BFF helpers
 * (`server/utils/oauth-callback.ts`).
 *
 * These run in the plain `node` project with no Nitro server and no network:
 * they pin the four pure pieces the route handler leans on — the provider-slug
 * shape gate (injection safety), the query allowlist (only the OAuth params ride
 * upstream, values untouched), the site-relative redirect guard (no host leak or
 * open redirect), and the backend-URL builder (the slug can never reshape the
 * path). `forwardOAuthCallback`'s live wiring is proven over HTTP in the e2e spec.
 */
import { describe, expect, it } from 'vitest';

import {
  buildBackendCallbackUrl,
  CALLBACK_QUERY_ALLOWLIST,
  isForwardableProviderSlug,
  pickCallbackParams,
  SAFE_FALLBACK_PATH,
  safeRelativeLocation,
} from '../../server/utils/oauth-callback';

describe('isForwardableProviderSlug', () => {
  it('accepts a well-formed provider slug (foundation shape)', () => {
    for (const ok of ['github', 'g', 'a-b-c', 'g1', 'x'.repeat(32)]) {
      expect(isForwardableProviderSlug(ok)).toBe(true);
    }
  });

  it('rejects a malformed slug so it can never shape a backend URL', () => {
    for (const bad of ['', 'A', 'GitHub', '1github', 'has_underscore', 'has.dot', 'a/b', '-lead', 'x'.repeat(33), 'évil']) {
      expect(isForwardableProviderSlug(bad)).toBe(false);
    }
  });

  it('rejects non-string input', () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      expect(isForwardableProviderSlug(bad)).toBe(false);
    }
  });
});

describe('pickCallbackParams', () => {
  it('keeps exactly the OAuth allowlist and nothing else', () => {
    const picked = pickCallbackParams({
      state: 'st',
      code: 'cd',
      error: 'access_denied',
      error_description: 'nope',
      error_uri: 'https://p/e',
      redirect_uri: 'https://evil.example',
      utm_source: 'x',
      foo: 'bar',
    });
    expect(picked).toEqual({
      state: 'st',
      code: 'cd',
      error: 'access_denied',
      error_description: 'nope',
      error_uri: 'https://p/e',
    });
    expect([...CALLBACK_QUERY_ALLOWLIST]).toEqual(['state', 'code', 'error', 'error_description', 'error_uri']);
  });

  it('drops a duplicated (array) param as ambiguous and skips empty values', () => {
    expect(pickCallbackParams({ state: ['a', 'b'], code: '' })).toEqual({});
  });

  it('preserves param values byte-for-byte (no decoding or trimming)', () => {
    const value = ' a+b/c=%2F ';
    expect(pickCallbackParams({ code: value }).code).toBe(value);
  });
});

describe('safeRelativeLocation', () => {
  it('accepts a site-relative path', () => {
    for (const ok of ['/connections', '/connections?from=github', '/a/b/c']) {
      expect(safeRelativeLocation(ok)).toBe(ok);
    }
  });

  it('rejects anything that could carry a host or escape the origin', () => {
    for (const bad of [
      'http://evil.example/x',
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/a\\b',
      '/has space',
      '/\u0000',
      'connections',
      '',
      null,
      undefined,
    ]) {
      expect(safeRelativeLocation(bad)).toBeNull();
    }
  });
});

describe('buildBackendCallbackUrl', () => {
  it('targets the backend callback path and carries only the given params', () => {
    const parsed = new URL(
      buildBackendCallbackUrl('https://api.internal.example', 'github', { state: 'st', code: 'cd' }),
    );
    expect(parsed.origin).toBe('https://api.internal.example');
    expect(parsed.pathname).toBe('/oauth/github/callback');
    expect(parsed.searchParams.get('state')).toBe('st');
    expect(parsed.searchParams.get('code')).toBe('cd');
  });

  it('drops any pre-existing path or query on the configured backend URL', () => {
    const parsed = new URL(buildBackendCallbackUrl('https://api.example/base?leftover=1', 'slack', {}));
    expect(parsed.pathname).toBe('/oauth/slack/callback');
    expect(parsed.search).toBe('');
  });

  it('exposes the shared fallback path', () => {
    expect(SAFE_FALLBACK_PATH).toBe('/connections');
  });
});
