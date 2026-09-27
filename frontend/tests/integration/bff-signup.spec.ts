/**
 * BFF self-serve-signup end-to-end tests. Boots a real Nitro server (via
 * `@nuxt/test-utils`) pointed at a `node:http` Fastify mock and drives the
 * dedicated `POST /backend/auth/signup` route through the real HTTP boundary —
 * proving (Phase 5 §7/§11/§12) that the brand-new opaque session token lives
 * only in the HttpOnly `aw_session` cookie (never a browser body), that the BFF
 * (not the browser) controls the upstream credential so a browser-supplied
 * Authorization/Cookie cannot override it, that the browser Cookie is never
 * forwarded, that a plaintext password never leaks back to the browser, and that
 * CSRF/Origin is enforced. Node's fetch sends no Origin header, so same-origin is
 * simulated via `origin:`.
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
const VALID_BODY = {
  name: 'Ada Owner',
  email: 'ada@example.test',
  password: 'SUPER_SECRET_PW_do_not_leak',
  workspaceName: 'Acme Inc',
};

// The upstream's 201 body carries the raw token; the BFF must strip it into the
// cookie and never echo it (or the password) back to the browser.
const signupSuccessBody = (token: string): string =>
  JSON.stringify({
    user: { id: 'u1', email: 'ada@example.test', name: 'Ada Owner' },
    tenant: { id: 't1', name: 'Acme Inc' },
    session: { token, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });

/** POST like a browser: JSON body + an explicit Origin, plus optional extra
 *  headers so a test can simulate a hostile browser trying to smuggle a
 *  credential past the BFF. */
function post(
  path: string,
  bodyObj: unknown,
  origin: string | undefined,
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...extraHeaders,
  };
  if (origin !== undefined) headers.origin = origin;
  return nuxtFetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(bodyObj),
    ignoreResponseError: true,
  });
}
describe('BFF signup /backend/auth/signup', () => {
  it('sets an HttpOnly aw_session cookie and returns safe metadata (no token, no password)', async () => {
    const token = 'BRAND_NEW_SESSION_TOKEN_do_not_leak';
    upstream.setHandler(() => ({ status: 201, body: signupSuccessBody(token) }));
    upstream.clearHits();
    const res = await post('/backend/auth/signup', VALID_BODY, selfOrigin());
    expect(res.status).toBe(201);
    const setCookie = res.headers.get('set-cookie');
    expect(cookieValue(setCookie)).toBe(token);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain('Secure'); // plain-HTTP test server
    const raw = await res.text();
    const body = JSON.parse(raw) as {
      user?: unknown;
      tenant?: unknown;
      session?: { token?: string; expiresAt?: string };
    };
    expect(body.user).toBeDefined();
    expect(body.tenant).toBeDefined();
    expect(typeof body.session?.expiresAt).toBe('string');
    expect(body.session?.token).toBeUndefined();
    // Neither the raw session token nor the plaintext password ever comes back.
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(VALID_BODY.password);
    // The BFF forwarded exactly the four account facts, with NO credential and
    // WITHOUT the browser cookie.
    const hit = upstream.hits()[0];
    expect(hit.method).toBe('POST');
    expect(hit.url).toContain('/auth/signup');
    expect(hit.headers.authorization).toBeUndefined();
    expect(hit.headers.cookie).toBeUndefined();
    expect(JSON.parse(hit.body)).toEqual(VALID_BODY);
  });

  it('ignores a browser-supplied Authorization or Cookie (the BFF, not the browser, picks the credential)', async () => {
    const token = 'SERVER_ISSUED_TOKEN';
    upstream.setHandler(() => ({ status: 201, body: signupSuccessBody(token) }));
    upstream.clearHits();
    const res = await post('/backend/auth/signup', VALID_BODY, selfOrigin(), {
      authorization: 'Bearer attacker-supplied-key',
      cookie: 'aw_session=attacker-stolen-token',
    });
    expect(res.status).toBe(201);
    // Signup is public: the BFF forwards no credential, so the smuggled header
    // and cookie are inert — the upstream sees neither.
    const hit = upstream.hits()[0];
    expect(hit.headers.authorization).toBeUndefined();
    expect(hit.headers.cookie).toBeUndefined();
    // The browser receives the server-issued token, never the smuggled one.
    expect(cookieValue(res.headers.get('set-cookie'))).toBe(token);
  });
});
describe('BFF signup — error relay', () => {
  it('relays a 409 duplicate generically, setting no cookie and leaking no secret', async () => {
    upstream.setHandler(() => ({
      status: 409,
      body: JSON.stringify({
        error: {
          code: 'email_unavailable',
          message: 'That email address cannot be used to create an account.',
        },
      }),
    }));
    upstream.clearHits();
    const res = await post('/backend/auth/signup', VALID_BODY, selfOrigin());
    expect(res.status).toBe(409);
    const raw = await res.text();
    expect(JSON.parse(raw).error.code).toBe('email_unavailable');
    expect(res.headers.get('set-cookie')).toBeNull();
    // No token/password material even on the failure path.
    expect(raw).not.toContain(VALID_BODY.password);
  });

  it('rejects a blank field with 400 before any upstream call', async () => {
    upstream.clearHits();
    const res = await post('/backend/auth/signup', { ...VALID_BODY, workspaceName: '' }, selfOrigin());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('bad_request');
    expect(upstream.hits().length).toBe(0);
  });

  it('relays a 502 with no cookie when the upstream 201 omits the token', async () => {
    upstream.setHandler(() => ({
      status: 201,
      body: JSON.stringify({ user: { id: 'u1' }, tenant: { id: 't1' }, session: { expiresAt: 'x' } }),
    }));
    upstream.clearHits();
    const res = await post('/backend/auth/signup', VALID_BODY, selfOrigin());
    expect(res.status).toBe(502);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
describe('BFF signup — CSRF / Origin enforcement', () => {
  it('rejects a cross-origin signup with 403, hitting no upstream and setting no cookie', async () => {
    upstream.clearHits();
    const res = await post('/backend/auth/signup', VALID_BODY, EVIL_ORIGIN);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('forbidden_origin');
    expect(upstream.hits().length).toBe(0);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a signup carrying neither Origin nor Referer with 403', async () => {
    upstream.clearHits();
    const res = await post('/backend/auth/signup', VALID_BODY, undefined);
    expect(res.status).toBe(403);
    expect(upstream.hits().length).toBe(0);
  });

  it('accepts a signup from a configured trusted origin', async () => {
    upstream.setHandler(() => ({ status: 201, body: signupSuccessBody('TRUSTED_TOKEN') }));
    upstream.clearHits();
    const res = await post('/backend/auth/signup', VALID_BODY, TRUSTED_ORIGIN);
    expect(res.status).toBe(201);
    expect(cookieValue(res.headers.get('set-cookie'))).toBe('TRUSTED_TOKEN');
    expect(upstream.hits().length).toBe(1);
  });
});
describe('BFF signup — method and route safety', () => {
  it('leaves the catch-all GET/HEAD-only: an arbitrary POST to a non-auth path is still 405', async () => {
    upstream.clearHits();
    const res = await nuxtFetch('/backend/v1/workflows', {
      method: 'POST',
      headers: { accept: 'application/json' },
      ignoreResponseError: true,
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect(upstream.hits().length).toBe(0);
  });
});
