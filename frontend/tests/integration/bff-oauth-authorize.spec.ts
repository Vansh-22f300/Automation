/**
 * BFF GitHub-OAuth authorize end-to-end tests: a real Nitro server (via
 * `@nuxt/test-utils`) over a `node:http` Fastify mock, driving POST
 * `/backend/oauth/github/authorize` across the real HTTP boundary. Proves the
 * Connect-GitHub §4 contract — session cookie required, CSRF enforced, only the
 * server-derived Bearer forwarded (browser Authorization/Cookie ignored, machine
 * key never used), a fixed upstream body, only `{ authorizationUrl }` returned,
 * sanitized upstream errors, and the GET/HEAD-only data plane left intact.
 */
import { resolve as resolvePath } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fetch as nuxtFetch, setup, url } from '@nuxt/test-utils/e2e';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock';

const TEST_API_KEY = 'test-server-key-do-not-leak-github-authorize';
const TRUSTED_ORIGIN = 'https://app.trusted.example';
const EVIL_ORIGIN = 'https://evil.example';
// Opaque to the BFF: it relays whatever Fastify returns and never validates the
// URL (that is the client/page's job). Deliberately NOT guard-valid (no
// redirect_uri/code_challenge) so a future edit can't "fix" it into implying the
// BFF validates.
const AUTHORIZE_URL =
  'https://github.com/login/oauth/authorize?client_id=abc&state=xyz&scope=read%3Auser';
const ROOT_DIR = resolvePath(process.cwd());

const upstream: UpstreamMock = await startUpstreamMock();

process.env.NUXT_API_KEY = TEST_API_KEY;
process.env.NUXT_BACKEND_URL = upstream.url();
process.env.NUXT_PUBLIC_API_BASE = '/backend';
process.env.NUXT_BFF_TIMEOUT_MS = '500';
process.env.NUXT_TRUSTED_ORIGINS = TRUSTED_ORIGIN;

await setup({ rootDir: ROOT_DIR, dev: false, server: true });

afterAll(async () => {
  await upstream.close();
});

let selfOriginCache: string | undefined;
function selfOrigin(): string {
  if (selfOriginCache === undefined) selfOriginCache = new URL(url('/')).origin;
  return selfOriginCache;
}

const PATH = '/backend/oauth/github/authorize';
const okReply = () => ({ status: 200, body: JSON.stringify({ authorizationUrl: AUTHORIZE_URL }) });

function authorize(opts: { origin?: string; cookie?: string; extra?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  Object.assign(headers, opts.extra ?? {});
  return nuxtFetch(PATH, { method: 'POST', headers, ignoreResponseError: true });
}
describe('BFF GitHub authorize — auth + CSRF gates', () => {
  it('rejects a missing session cookie with 401 and makes no upstream call', async () => {
    upstream.setHandler(okReply);
    upstream.clearHits();
    const res = await authorize({ origin: selfOrigin() });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('unauthorized');
    expect(upstream.hits().length).toBe(0);
  });

  it('rejects a cross-origin request with 403 and makes no upstream call', async () => {
    upstream.setHandler(okReply);
    upstream.clearHits();
    const res = await authorize({ origin: EVIL_ORIGIN, cookie: 'aw_session=REAL' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('forbidden_origin');
    expect(upstream.hits().length).toBe(0);
  });

  it('rejects a request carrying neither Origin nor Referer with 403', async () => {
    upstream.clearHits();
    const res = await authorize({ cookie: 'aw_session=REAL' });
    expect(res.status).toBe(403);
    expect(upstream.hits().length).toBe(0);
  });

  it('accepts a request from a configured trusted origin', async () => {
    upstream.setHandler(okReply);
    upstream.clearHits();
    const res = await authorize({ origin: TRUSTED_ORIGIN, cookie: 'aw_session=REAL' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { authorizationUrl?: string }).authorizationUrl).toBe(AUTHORIZE_URL);
  });
});
describe('BFF GitHub authorize — credential handling', () => {
  it('forwards the session cookie as a Bearer with the fixed body, returning only the URL', async () => {
    upstream.setHandler(okReply);
    upstream.clearHits();
    const res = await authorize({ origin: selfOrigin(), cookie: 'aw_session=REAL_SESSION' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorizationUrl?: string };
    expect(body.authorizationUrl).toBe(AUTHORIZE_URL);
    expect(JSON.stringify(body)).not.toContain('REAL_SESSION');
    const hit = upstream.hits()[0];
    expect(hit.method).toBe('POST');
    expect(hit.url).toContain('/v1/oauth/github/authorize');
    expect(hit.headers.authorization).toBe('Bearer REAL_SESSION');
    expect(hit.headers.cookie).toBeUndefined();
    expect(JSON.parse(hit.body)).toEqual({ returnPath: '/connections?connected=github' });
  });

  it('ignores a browser-injected Authorization header and never uses the machine API key', async () => {
    upstream.setHandler(okReply);
    upstream.clearHits();
    const res = await authorize({
      origin: selfOrigin(),
      cookie: 'aw_session=REAL_SESSION',
      extra: { authorization: 'Bearer attacker-supplied-token' },
    });
    expect(res.status).toBe(200);
    const hit = upstream.hits()[0];
    expect(hit.headers.authorization).toBe('Bearer REAL_SESSION');
    expect(hit.headers.authorization).not.toContain('attacker-supplied-token');
    expect(hit.headers.authorization).not.toBe(`Bearer ${TEST_API_KEY}`);
  });
});
describe('BFF GitHub authorize — upstream outcomes', () => {
  it('relays a 404 disabled-provider state as a sanitized envelope', async () => {
    upstream.setHandler(() => ({ status: 404, body: JSON.stringify({ error: { code: 'not_found', message: 'OAuth provider not found' } }) }));
    upstream.clearHits();
    const res = await authorize({ origin: selfOrigin(), cookie: 'aw_session=REAL' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('not_found');
  });

  it('relays a 401 from the backend (expired or invalid session)', async () => {
    upstream.setHandler(() => ({ status: 401, body: JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }) }));
    upstream.clearHits();
    const res = await authorize({ origin: selfOrigin(), cookie: 'aw_session=STALE' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('unauthorized');
  });

  it('collapses a malformed non-JSON upstream 500 to a generic upstream_error', async () => {
    upstream.setHandler(() => ({ status: 500, body: 'definitely not json' }));
    upstream.clearHits();
    const res = await authorize({ origin: selfOrigin(), cookie: 'aw_session=REAL' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('upstream_error');
    expect(body.error?.message).not.toContain('definitely not json');
  });

  it('maps an upstream timeout to 504 upstream_timeout', async () => {
    upstream.setHandler(() => ({ status: 200, body: JSON.stringify({ authorizationUrl: AUTHORIZE_URL }), delayMs: 2_000 }));
    upstream.clearHits();
    const res = await authorize({ origin: selfOrigin(), cookie: 'aw_session=REAL' });
    expect(res.status).toBe(504);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('upstream_timeout');
  });

  it('returns 502 when the backend omits authorizationUrl', async () => {
    upstream.setHandler(() => ({ status: 200, body: JSON.stringify({ nope: true }) }));
    upstream.clearHits();
    const res = await authorize({ origin: selfOrigin(), cookie: 'aw_session=REAL' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('upstream_error');
  });
});
describe('BFF GitHub authorize — data-plane safety unchanged', () => {
  it('leaves the generic catch-all GET/HEAD-only: an unrelated POST is still 405', async () => {
    upstream.clearHits();
    const res = await nuxtFetch('/backend/v1/connections', {
      method: 'POST',
      headers: { accept: 'application/json' },
      ignoreResponseError: true,
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect(upstream.hits().length).toBe(0);
  });
});
