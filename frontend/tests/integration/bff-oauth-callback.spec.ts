/**
 * Public OAuth-callback BFF end-to-end tests (fix/oauth-callback-bff).
 *
 * The provider redirects the browser to `{APP_ORIGIN}/oauth/:provider/callback`,
 * and APP_ORIGIN is THIS public frontend origin — so the top-level Nitro route
 * forwards the callback server-side to Fastify and re-emits Fastify's relative
 * redirect on this origin. Boots a real Nitro server (via `@nuxt/test-utils`)
 * pointed at a `node:http` Fastify mock and drives the route through the real
 * HTTP boundary, proving the task's A–H:
 *   A a valid callback is forwarded; B a well-formed-but-unregistered slug still
 *   reaches the backend (no frontend allowlist / enumeration oracle); C a
 *   malformed slug fails locally with no upstream call; D state/code are
 *   forwarded byte-exact and never echoed to the browser; E a backend 302 becomes
 *   a same-origin 302; F backend 4xx/5xx collapse to a safe envelope; G non-
 *   allowlisted query params are dropped; H an absolute/backend Location can
 *   never leak into the browser-facing redirect.
 */
import { resolve as resolvePath } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fetch as nuxtFetch, setup } from '@nuxt/test-utils/e2e';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock';

const ROOT_DIR = resolvePath(process.cwd());
const upstream: UpstreamMock = await startUpstreamMock();

process.env.NUXT_BACKEND_URL = upstream.url();
process.env.NUXT_PUBLIC_API_BASE = '/backend';
process.env.NUXT_BFF_TIMEOUT_MS = '500';

await setup({ rootDir: ROOT_DIR, dev: false, server: true });

afterAll(async () => {
  await upstream.close();
});

/** A browser landing on the OAuth callback is a top-level GET navigation. */
function callback(path: string) {
  return nuxtFetch(path, { redirect: 'manual', headers: { accept: 'text/html' }, ignoreResponseError: true });
}

/** Parse an upstream `req.url` (path + query) against a throwaway origin. */
function hitUrl(mock: UpstreamMock): URL {
  return new URL(mock.hits()[0].url, 'http://local');
}

const REDIRECT_TO_CONNECTIONS = { status: 302, headers: { location: '/connections' }, body: '' } as const;

describe('GET /oauth/:provider/callback — happy path', () => {
  it('forwards the callback and re-emits the relative redirect on this origin (A, E)', async () => {
    upstream.setHandler(() => REDIRECT_TO_CONNECTIONS);
    upstream.clearHits();
    const res = await callback('/oauth/github/callback?state=st&code=cd');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/connections');

    const hit = upstream.hits()[0];
    expect(hit.method).toBe('GET');
    expect(hitUrl(upstream).pathname).toBe('/oauth/github/callback');
    // Public callback: no browser credential is ever forwarded upstream.
    expect(hit.headers.authorization).toBeUndefined();
    expect(hit.headers.cookie).toBeUndefined();
  });

  it('forwards state and code byte-exact and never echoes them to the browser (D)', async () => {
    upstream.setHandler(() => REDIRECT_TO_CONNECTIONS);
    upstream.clearHits();
    const state = 'STATE-sentinel.9_x~y';
    const code = 'CODE-sentinel.4_z~w';
    const res = await callback(`/oauth/github/callback?state=${state}&code=${code}`);
    const u = hitUrl(upstream);
    expect(u.searchParams.get('state')).toBe(state);
    expect(u.searchParams.get('code')).toBe(code);
    const location = res.headers.get('location') ?? '';
    expect(location).not.toContain(state);
    expect(location).not.toContain(code);
  });

  it('forwards only the OAuth allowlist, dropping arbitrary query params (G)', async () => {
    upstream.setHandler(() => REDIRECT_TO_CONNECTIONS);
    upstream.clearHits();
    await callback('/oauth/github/callback?state=s&code=c&redirect_uri=https://evil.example&utm_source=x&foo=bar');
    const u = hitUrl(upstream);
    expect(u.searchParams.get('state')).toBe('s');
    expect(u.searchParams.get('code')).toBe('c');
    expect(u.searchParams.has('redirect_uri')).toBe(false);
    expect(u.searchParams.has('utm_source')).toBe(false);
    expect(u.searchParams.has('foo')).toBe(false);
  });
});

describe('GET /oauth/:provider/callback — provider gating', () => {
  it('forwards a well-formed but unregistered slug to the backend, relaying its safe error (B)', async () => {
    upstream.setHandler(() => ({
      status: 400,
      body: JSON.stringify({ error: { code: 'oauth_state_invalid', message: 'Invalid or expired OAuth state.' } }),
    }));
    upstream.clearHits();
    const res = await callback('/oauth/evil-provider/callback?state=s&code=c');
    expect(res.status).toBe(400);
    // The shape-gate let it through; the BACKEND — not a frontend allowlist — judges the provider.
    expect(hitUrl(upstream).pathname).toBe('/oauth/evil-provider/callback');
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('oauth_state_invalid');
  });

  it('rejects a malformed slug locally with 400 and never calls the backend (C)', async () => {
    upstream.clearHits();
    const res = await callback('/oauth/Bad_Provider/callback?state=s&code=c');
    expect(res.status).toBe(400);
    expect(upstream.hits().length).toBe(0);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('bad_request');
  });
});

describe('GET /oauth/:provider/callback — backend errors (F)', () => {
  it('relays a structured backend 4xx as a safe envelope, preserving status', async () => {
    upstream.setHandler(() => ({
      status: 404,
      body: JSON.stringify({ error: { code: 'unknown_provider', message: 'No such provider.', requestId: 'req-123' } }),
    }));
    upstream.clearHits();
    const res = await callback('/oauth/github/callback?error=access_denied');
    expect(res.status).toBe(404);
    expect((await res.json()) as unknown).toEqual({
      error: { code: 'unknown_provider', message: 'No such provider.', requestId: 'req-123' },
    });
  });

  it('collapses an unexpected backend 5xx body to a generic envelope (no raw leak)', async () => {
    upstream.setHandler(() => ({ status: 500, body: 'Internal Server Error: secret stack trace at db.ts:42' }));
    upstream.clearHits();
    const res = await callback('/oauth/github/callback?state=s&code=c');
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain('secret stack trace');
    expect((JSON.parse(raw) as { error: { code: string } }).error.code).toBe('oauth_callback_error');
  });

  it('maps an upstream timeout to 504', async () => {
    upstream.setHandler(() => ({ ...REDIRECT_TO_CONNECTIONS, delayMs: 2_000 }));
    upstream.clearHits();
    const res = await callback('/oauth/github/callback?state=s&code=c');
    expect(res.status).toBe(504);
  });
});

describe('GET /oauth/:provider/callback — redirect safety (H)', () => {
  it('never lets an absolute backend Location reach the browser', async () => {
    upstream.setHandler(() => ({ status: 302, headers: { location: `${upstream.url()}/connections?leak=1` }, body: '' }));
    upstream.clearHits();
    const res = await callback('/oauth/github/callback?state=s&code=c');
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toBe('/connections');
    expect(location).not.toContain('127.0.0.1');
    expect(location).not.toContain(upstream.port().toString());
  });

  it('collapses a protocol-relative Location to the safe fallback', async () => {
    upstream.setHandler(() => ({ status: 302, headers: { location: '//evil.example/phish' }, body: '' }));
    upstream.clearHits();
    const res = await callback('/oauth/github/callback?state=s&code=c');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/connections');
  });
});
