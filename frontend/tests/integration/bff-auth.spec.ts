/**
 * BFF human-auth end-to-end tests. Boots a real Nitro server (via
 * `@nuxt/test-utils`) pointed at a `node:http` Fastify mock and drives the
 * dedicated `/backend/auth/{login,logout,session}` routes through the real HTTP
 * boundary — proving (Phase 4 §2–§9) that the opaque token lives only in the
 * HttpOnly `aw_session` cookie (never a browser body), that the BFF (not the
 * browser) controls the upstream credential, that the browser Cookie is never
 * forwarded, and that CSRF/Origin is enforced on POST but exempt on GET. Node's
 * fetch sends no Origin header, so same-origin is simulated via `origin:`.
 */
import { resolve as resolvePath } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fetch as nuxtFetch, setup, url } from '@nuxt/test-utils/e2e';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock';

const TEST_API_KEY = 'test-server-key-do-not-leak-1234567890abcdef';
const TRUSTED_ORIGIN = 'https://app.trusted.example';
const EVIL_ORIGIN = 'https://evil.example';
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

// The @nuxt/test-utils server boots in a beforeAll hook registered by `setup`,
// not during `await setup()`, so its URL is only known once tests run. Resolve
// the same-origin value lazily (inside a test) rather than at module load.
let selfOriginCache: string | undefined;
function selfOrigin(): string {
  if (selfOriginCache === undefined) selfOriginCache = new URL(url('/')).origin;
  return selfOriginCache;
}

function cookieValue(setCookie: string | null): string | undefined {
  if (setCookie === null) return undefined;
  const match = setCookie.match(/aw_session=([^;]*)/);
  return match ? match[1] : undefined;
}

const loginSuccessBody = (token: string): string =>
  JSON.stringify({
    user: { id: 'u1', email: 'person@example.test', name: 'Person' },
    tenant: { id: 't1', name: 'Tenant One' },
    session: { token, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });

/** POST helper mirroring a browser fetch: JSON body + an explicit Origin. */
function post(path: string, bodyObj: unknown, origin: string | undefined) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (origin !== undefined) headers.origin = origin;
  return nuxtFetch(path, { method: 'POST', headers, body: JSON.stringify(bodyObj), ignoreResponseError: true });
}

describe('BFF auth /backend/auth/login', () => {
  it('sets an HttpOnly aw_session cookie and returns safe metadata (no token)', async () => {
    const token = 'SECRET_SESSION_TOKEN_do_not_leak';
    upstream.setHandler(() => ({ status: 200, body: loginSuccessBody(token) }));
    upstream.clearHits();
    const res = await post('/backend/auth/login', { email: 'person@example.test', password: 'pw' }, selfOrigin());
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(cookieValue(setCookie)).toBe(token);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Secure'); // plain-HTTP test server
    const body = (await res.json()) as { user?: unknown; tenant?: unknown; session?: { token?: string; expiresAt?: string } };
    expect(body.user).toBeDefined();
    expect(body.tenant).toBeDefined();
    expect(typeof body.session?.expiresAt).toBe('string');
    expect(body.session?.token).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(token);
    const hit = upstream.hits()[0];
    expect(hit.method).toBe('POST');
    expect(hit.url).toContain('/auth/login');
    expect(hit.headers.authorization).toBeUndefined(); // public endpoint — no credential
    expect(hit.headers.cookie).toBeUndefined(); // browser cookie never forwarded
    expect(JSON.parse(hit.body)).toEqual({ email: 'person@example.test', password: 'pw' });
  });
});

describe('BFF auth /backend/auth/login — error relay', () => {
  it('relays 401 for bad credentials and sets no cookie', async () => {
    upstream.setHandler(() => ({ status: 401, body: JSON.stringify({ error: { code: 'unauthorized', message: 'Invalid email or password.' } }) }));
    upstream.clearHits();
    const res = await post('/backend/auth/login', { email: 'a@b.test', password: 'wrong' }, selfOrigin());
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('unauthorized');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('relays 409 tenant-selection-required without leaking a tenant id or a cookie', async () => {
    upstream.setHandler(() => ({ status: 409, body: JSON.stringify({ error: { code: 'tenant_selection_required', message: 'Additional selection is required.' } }) }));
    upstream.clearHits();
    const res = await post('/backend/auth/login', { email: 'multi@b.test', password: 'pw' }, selfOrigin());
    expect(res.status).toBe(409);
    const raw = await res.text();
    expect(JSON.parse(raw).error.code).toBe('tenant_selection_required');
    expect(raw).not.toContain('t1');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a blank field with 400 before any upstream call', async () => {
    upstream.clearHits();
    const res = await post('/backend/auth/login', { email: 'a@b.test', password: '' }, selfOrigin());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('bad_request');
    expect(upstream.hits().length).toBe(0);
  });
});

describe('BFF auth /backend/auth/session', () => {
  it('translates the cookie into an upstream Bearer and returns only user/tenant', async () => {
    upstream.setHandler(() => ({ status: 200, body: JSON.stringify({ user: { id: 'u1', email: 'a@b.test', name: 'A' }, tenant: { id: 't1', name: 'T' } }) }));
    upstream.clearHits();
    const res = await nuxtFetch('/backend/auth/session', { headers: { accept: 'application/json', cookie: 'aw_session=TOK_123' }, ignoreResponseError: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user?: unknown; tenant?: unknown; session?: unknown };
    expect(body.user).toBeDefined();
    expect(body.tenant).toBeDefined();
    expect(JSON.stringify(body)).not.toContain('TOK_123');
    const hit = upstream.hits()[0];
    expect(hit.method).toBe('GET');
    expect(hit.url).toContain('/auth/session');
    expect(hit.headers.authorization).toBe('Bearer TOK_123');
    expect(hit.headers.cookie).toBeUndefined();
  });

  it('returns 401 with no upstream call when no cookie is present', async () => {
    upstream.clearHits();
    const res = await nuxtFetch('/backend/auth/session', { headers: { accept: 'application/json' }, ignoreResponseError: true });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('unauthorized');
    expect(upstream.hits().length).toBe(0);
  });

  it('clears the cookie and returns 401 when the backend rejects the token', async () => {
    upstream.setHandler(() => ({ status: 401, body: JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }) }));
    upstream.clearHits();
    const res = await nuxtFetch('/backend/auth/session', { headers: { accept: 'application/json', cookie: 'aw_session=STALE' }, ignoreResponseError: true });
    expect(res.status).toBe(401);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('aw_session=');
    expect(setCookie).toMatch(/Max-Age=0|Expires=/i);
  });

  it('leaves the cookie intact and returns 504 when the backend times out', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{}', delayMs: 2_000 }));
    upstream.clearHits();
    const res = await nuxtFetch('/backend/auth/session', { headers: { accept: 'application/json', cookie: 'aw_session=LIVE' }, ignoreResponseError: true });
    expect(res.status).toBe(504);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('upstream_timeout');
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('BFF auth /backend/auth/logout', () => {
  function logout(cookie: string | undefined, origin: string | undefined) {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (cookie !== undefined) headers.cookie = cookie;
    if (origin !== undefined) headers.origin = origin;
    return nuxtFetch('/backend/auth/logout', { method: 'POST', headers, ignoreResponseError: true });
  }

  it('revokes the cookie token upstream, clears the cookie, and returns 204', async () => {
    upstream.setHandler(() => ({ status: 204, body: '' }));
    upstream.clearHits();
    const res = await logout('aw_session=REVOKE_ME', selfOrigin());
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const hit = upstream.hits()[0];
    expect(hit.method).toBe('POST');
    expect(hit.url).toContain('/auth/logout');
    expect(hit.headers.authorization).toBe('Bearer REVOKE_ME');
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('aw_session=');
    expect(setCookie).toMatch(/Max-Age=0|Expires=/i);
  });

  it('returns 204 and clears the cookie with no upstream call when no cookie is present', async () => {
    upstream.clearHits();
    const res = await logout(undefined, selfOrigin());
    expect(res.status).toBe(204);
    expect(upstream.hits().length).toBe(0);
    expect(res.headers.get('set-cookie')).toContain('aw_session=');
  });

  it('still returns 204 and clears the cookie when the backend says the session is already revoked', async () => {
    upstream.setHandler(() => ({ status: 401, body: JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }) }));
    upstream.clearHits();
    const res = await logout('aw_session=ALREADY_DEAD', selfOrigin());
    expect(res.status).toBe(204);
    expect(upstream.hits().length).toBe(1);
    expect(res.headers.get('set-cookie')).toContain('aw_session=');
  });
});

describe('BFF auth — CSRF / Origin enforcement', () => {
  it('rejects a cross-origin login with 403, hitting no upstream and setting no cookie', async () => {
    upstream.clearHits();
    const res = await post('/backend/auth/login', { email: 'a@b.test', password: 'pw' }, EVIL_ORIGIN);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('forbidden_origin');
    expect(upstream.hits().length).toBe(0);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a cross-origin logout with 403 and does not clear the cookie', async () => {
    upstream.clearHits();
    const res = await nuxtFetch('/backend/auth/logout', { method: 'POST', headers: { accept: 'application/json', cookie: 'aw_session=KEEP', origin: EVIL_ORIGIN }, ignoreResponseError: true });
    expect(res.status).toBe(403);
    expect(upstream.hits().length).toBe(0);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a login carrying neither Origin nor Referer with 403', async () => {
    upstream.clearHits();
    const res = await post('/backend/auth/login', { email: 'a@b.test', password: 'pw' }, undefined);
    expect(res.status).toBe(403);
    expect(upstream.hits().length).toBe(0);
  });

  it('accepts a login from a configured trusted origin', async () => {
    upstream.setHandler(() => ({ status: 200, body: loginSuccessBody('TRUSTED_TOKEN') }));
    upstream.clearHits();
    const res = await post('/backend/auth/login', { email: 'a@b.test', password: 'pw' }, TRUSTED_ORIGIN);
    expect(res.status).toBe(200);
    expect(cookieValue(res.headers.get('set-cookie'))).toBe('TRUSTED_TOKEN');
  });

  it('exempts the GET session probe from the Origin check', async () => {
    upstream.setHandler(() => ({ status: 200, body: JSON.stringify({ user: { id: 'u1' }, tenant: { id: 't1' } }) }));
    upstream.clearHits();
    const res = await nuxtFetch('/backend/auth/session', { headers: { accept: 'application/json', cookie: 'aw_session=TOK', origin: EVIL_ORIGIN }, ignoreResponseError: true });
    expect(res.status).toBe(200);
    expect(upstream.hits()[0].headers.authorization).toBe('Bearer TOK');
  });
});

describe('BFF auth — method and route safety', () => {
  it('keeps the catch-all GET/HEAD-only: a POST to a non-auth path is still 405', async () => {
    upstream.clearHits();
    const res = await nuxtFetch('/backend/v1/workflows', { method: 'POST', headers: { accept: 'application/json' }, ignoreResponseError: true });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect(upstream.hits().length).toBe(0);
  });

  it('never forwards or mutates on POST /backend/auth/session (the route is GET-only)', async () => {
    upstream.clearHits();
    const res = await nuxtFetch('/backend/auth/session', { method: 'POST', headers: { accept: 'application/json', cookie: 'aw_session=TOK', origin: selfOrigin() }, ignoreResponseError: true });
    // The dedicated probe is GET-only. A POST is inert: Nitro does not run the
    // GET handler for it, so the request never reaches the backend and the
    // cookie is neither used as a Bearer nor cleared — no state change, and no
    // authenticated identity is ever returned.
    expect(upstream.hits().length).toBe(0);
    expect(res.headers.get('set-cookie')).toBeNull();
    const raw = await res.text();
    expect(raw).not.toContain('"user"');
    expect(raw).not.toContain('"tenant"');
  });
});
