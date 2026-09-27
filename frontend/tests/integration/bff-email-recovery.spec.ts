/**
 * BFF email-verification & password-recovery end-to-end tests (Phase 6 §13/§18).
 *
 * Boots a real Nitro server (via `@nuxt/test-utils`) pointed at a `node:http`
 * Fastify mock and drives the dedicated recovery routes through the real HTTP
 * boundary, proving:
 *   - forgot-password is never a user-enumeration oracle (fixed generic 202 for
 *     every upstream outcome);
 *   - the reset one-time token rides ONLY the HttpOnly `aw_pwreset` cookie set by
 *     the GET handoff — never the SPA URL, a browser body, or a redirect target;
 *   - a successful reset clears both the reset cookie and any `aw_session`;
 *   - the verify handoff consumes the token server-side and redirects to a clean
 *     status URL that never carries the raw token;
 *   - resend is authenticated by the session cookie only (no browser-supplied
 *     identity) and CSRF-guarded; and
 *   - the machine API key and browser Cookie are never forwarded upstream.
 *
 * Node's fetch sends no Origin header, so same-origin is simulated via `origin:`.
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

// undici exposes each Set-Cookie separately via getSetCookie(); fall back to the
// (comma-joined) single header for older runtimes. Used to assert cookie writes.
function setCookies(res: { headers: Headers }): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const one = h.get('set-cookie');
  return one === null ? [] : [one];
}
function findCookie(res: { headers: Headers }, name: string): string | undefined {
  return setCookies(res).find((c) => c.startsWith(`${name}=`));
}
function cookieBody(res: { headers: Headers }, name: string): string | undefined {
  const raw = findCookie(res, name);
  if (raw === undefined) return undefined;
  const match = raw.match(new RegExp(`${name}=([^;]*)`));
  return match ? match[1] : undefined;
}

function post(path: string, bodyObj: unknown, origin: string | undefined, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (origin !== undefined) headers.origin = origin;
  if (cookie !== undefined) headers.cookie = cookie;
  return nuxtFetch(path, { method: 'POST', headers, body: JSON.stringify(bodyObj), ignoreResponseError: true });
}
// <!-- @@REST@@ -->

const GENERIC_FORGOT = 'If an account exists, password reset instructions will be sent.';

describe('BFF /backend/auth/forgot-password — enumeration-safe', () => {
  it('forwards { email } with no credential and returns the generic 202 on upstream 202', async () => {
    upstream.setHandler(() => ({ status: 202, body: JSON.stringify({ message: GENERIC_FORGOT }) }));
    upstream.clearHits();
    const res = await post('/backend/auth/forgot-password', { email: 'person@example.test' }, selfOrigin());
    expect(res.status).toBe(202);
    expect(((await res.json()) as { message?: string }).message).toBe(GENERIC_FORGOT);
    const hit = upstream.hits()[0];
    expect(hit.method).toBe('POST');
    expect(hit.url).toContain('/auth/forgot-password');
    expect(hit.headers.authorization).toBeUndefined();
    expect(hit.headers.cookie).toBeUndefined();
    expect(JSON.parse(hit.body)).toEqual({ email: 'person@example.test' });
  });

  it('returns the SAME generic 202 when the account is unknown (upstream 404) — no oracle', async () => {
    upstream.setHandler(() => ({ status: 404, body: JSON.stringify({ error: { code: 'not_found', message: 'no such user' } }) }));
    upstream.clearHits();
    const res = await post('/backend/auth/forgot-password', { email: 'ghost@example.test' }, selfOrigin());
    expect(res.status).toBe(202);
    const raw = await res.text();
    expect(JSON.parse(raw).message).toBe(GENERIC_FORGOT);
    expect(raw).not.toContain('not_found');
    expect(raw).not.toContain('no such user');
  });

  it('collapses an unexpected upstream 500 to the generic 202 (never leaks backend error)', async () => {
    upstream.setHandler(() => ({ status: 500, body: JSON.stringify({ error: { code: 'boom', message: 'stack trace' } }) }));
    upstream.clearHits();
    const res = await post('/backend/auth/forgot-password', { email: 'person@example.test' }, selfOrigin());
    expect(res.status).toBe(202);
    expect((await res.text())).not.toContain('stack trace');
  });

  it('rejects a blank email with 400 before any upstream call', async () => {
    upstream.clearHits();
    const res = await post('/backend/auth/forgot-password', { email: '   ' }, selfOrigin());
    expect(res.status).toBe(400);
    expect(upstream.hits().length).toBe(0);
  });

  it('rejects a cross-origin request with 403 and hits no upstream', async () => {
    upstream.clearHits();
    const res = await post('/backend/auth/forgot-password', { email: 'person@example.test' }, EVIL_ORIGIN);
    expect(res.status).toBe(403);
    expect(upstream.hits().length).toBe(0);
  });

  it('maps an upstream timeout to 504', async () => {
    upstream.setHandler(() => ({ status: 202, body: '{}', delayMs: 2_000 }));
    upstream.clearHits();
    const res = await post('/backend/auth/forgot-password', { email: 'person@example.test' }, selfOrigin());
    expect(res.status).toBe(504);
  });
});
// <!-- @@REST2@@ -->

describe('BFF /backend/auth/reset-password (GET handoff)', () => {
  it('stashes the token in an HttpOnly aw_pwreset cookie and redirects to a clean URL', async () => {
    upstream.clearHits();
    const res = await nuxtFetch('/backend/auth/reset-password?token=RAW_RESET_TOKEN', {
      redirect: 'manual', headers: { accept: 'text/html' }, ignoreResponseError: true,
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toBe('/reset-password');
    expect(location).not.toContain('RAW_RESET_TOKEN'); // token never in the SPA URL
    const cookie = findCookie(res, 'aw_pwreset');
    expect(cookieBody(res, 'aw_pwreset')).toBe('RAW_RESET_TOKEN');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(upstream.hits().length).toBe(0); // handoff does not consume the token
  });

  it('redirects to the invalid state and sets no cookie when the token is missing', async () => {
    upstream.clearHits();
    const res = await nuxtFetch('/backend/auth/reset-password', {
      redirect: 'manual', headers: { accept: 'text/html' }, ignoreResponseError: true,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/reset-password?status=invalid');
    expect(findCookie(res, 'aw_pwreset')).toBeUndefined();
  });
});

describe('BFF /backend/auth/reset-password (POST)', () => {
  it('reads the token from the cookie, forwards { token, password }, and clears BOTH cookies on success', async () => {
    upstream.setHandler(() => ({ status: 200, body: JSON.stringify({ message: 'Your password has been reset. Please sign in with your new password.' }) }));
    upstream.clearHits();
    const res = await post('/backend/auth/reset-password', { password: 'brand-new-pw' }, selfOrigin(), 'aw_pwreset=COOKIE_TOKEN; aw_session=OLD_SESSION');
    expect(res.status).toBe(200);
    const hit = upstream.hits()[0];
    expect(hit.url).toContain('/auth/reset-password');
    expect(JSON.parse(hit.body)).toEqual({ token: 'COOKIE_TOKEN', password: 'brand-new-pw' });
    expect(hit.headers.cookie).toBeUndefined();
    // Spent reset cookie AND any stale session cookie are both revoked.
    expect(findCookie(res, 'aw_pwreset')).toMatch(/Max-Age=0|Expires=/i);
    expect(findCookie(res, 'aw_session')).toMatch(/Max-Age=0|Expires=/i);
    expect(await res.text()).not.toContain('COOKIE_TOKEN');
  });

  it('returns a generic 400 with no upstream call when the reset cookie is absent', async () => {
    upstream.clearHits();
    const res = await post('/backend/auth/reset-password', { password: 'brand-new-pw' }, selfOrigin());
    expect(res.status).toBe(400);
    expect(upstream.hits().length).toBe(0);
  });

  it('rejects a short password with 400 and keeps the cookie for retry (no upstream call)', async () => {
    upstream.clearHits();
    const res = await post('/backend/auth/reset-password', { password: 'short' }, selfOrigin(), 'aw_pwreset=LIVE_TOKEN');
    expect(res.status).toBe(400);
    expect(upstream.hits().length).toBe(0);
    expect(findCookie(res, 'aw_pwreset')).toBeUndefined(); // untouched — not cleared
  });

  it('clears the spent reset cookie and relays a safe error on upstream 400 (dead token)', async () => {
    upstream.setHandler(() => ({ status: 400, body: JSON.stringify({ error: { code: 'bad_request', message: 'This password reset link is invalid or has expired.' } }) }));
    upstream.clearHits();
    const res = await post('/backend/auth/reset-password', { password: 'brand-new-pw' }, selfOrigin(), 'aw_pwreset=DEAD_TOKEN');
    expect(res.status).toBe(400);
    expect(findCookie(res, 'aw_pwreset')).toMatch(/Max-Age=0|Expires=/i);
  });

  it('keeps the cookie and returns 504 when the backend times out (transient)', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{}', delayMs: 2_000 }));
    upstream.clearHits();
    const res = await post('/backend/auth/reset-password', { password: 'brand-new-pw' }, selfOrigin(), 'aw_pwreset=LIVE_TOKEN');
    expect(res.status).toBe(504);
    expect(findCookie(res, 'aw_pwreset')).toBeUndefined(); // untouched — ret==able
  });

  it('rejects a cross-origin reset with 403 and hits no upstream', async () => {
    upstream.clearHits();
    const res = await post('/backend/auth/reset-password', { password: 'brand-new-pw' }, EVIL_ORIGIN, 'aw_pwreset=LIVE_TOKEN');
    expect(res.status).toBe(403);
    expect(upstream.hits().length).toBe(0);
  });
});
// <!-- @@REST3@@ -->

describe('BFF /backend/auth/verify-email (GET handoff)', () => {
  it('consumes the token server-side and redirects to a clean success URL (no raw token)', async () => {
    upstream.setHandler(() => ({ status: 200, body: JSON.stringify({ message: 'Your email address has been verified.' }) }));
    upstream.clearHits();
    const res = await nuxtFetch('/backend/auth/verify-email?token=RAW_VERIFY_TOKEN', {
      redirect: 'manual', headers: { accept: 'text/html' }, ignoreResponseError: true,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/verify-email?status=success');
    expect(res.headers.get('location')).not.toContain('RAW_VERIFY_TOKEN');
    const hit = upstream.hits()[0];
    expect(hit.method).toBe('POST');
    expect(hit.url).toContain('/auth/verify-email');
    expect(JSON.parse(hit.body)).toEqual({ token: 'RAW_VERIFY_TOKEN' });
  });

  it('redirects to the invalid state with no upstream call when the token is missing', async () => {
    upstream.clearHits();
    const res = await nuxtFetch('/backend/auth/verify-email', {
      redirect: 'manual', headers: { accept: 'text/html' }, ignoreResponseError: true,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/verify-email?status=invalid');
    expect(upstream.hits().length).toBe(0);
  });

  it('collapses an upstream 400 (spent/expired token) to the invalid state', async () => {
    upstream.setHandler(() => ({ status: 400, body: JSON.stringify({ error: { code: 'bad_request', message: 'nope' } }) }));
    upstream.clearHits();
    const res = await nuxtFetch('/backend/auth/verify-email?token=SPENT', {
      redirect: 'manual', headers: { accept: 'text/html' }, ignoreResponseError: true,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/verify-email?status=invalid');
  });

  it('maps a backend timeout to the retryable error state', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{}', delayMs: 2_000 }));
    upstream.clearHits();
    const res = await nuxtFetch('/backend/auth/verify-email?token=X', {
      redirect: 'manual', headers: { accept: 'text/html' }, ignoreResponseError: true,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/verify-email?status=error');
  });
});

describe('BFF /backend/auth/email-verification/resend (POST)', () => {
  it('authenticates via the session cookie only and forwards a Bearer (no browser identity)', async () => {
    upstream.setHandler(() => ({ status: 200, body: JSON.stringify({ message: 'Verification email sent.' }) }));
    upstream.clearHits();
    const res = await post('/backend/auth/email-verification/resend', {}, selfOrigin(), 'aw_session=SESSION_TOK');
    expect(res.status).toBe(200);
    const hit = upstream.hits()[0];
    expect(hit.method).toBe('POST');
    expect(hit.url).toContain('/auth/email-verification/resend');
    expect(hit.headers.authorization).toBe('Bearer SESSION_TOK');
    expect(hit.headers.cookie).toBeUndefined();
  });

  it('returns 401 with no upstream call when no session cookie is present', async () => {
    upstream.clearHits();
    const res = await post('/backend/auth/email-verification/resend', {}, selfOrigin());
    expect(res.status).toBe(401);
    expect(upstream.hits().length).toBe(0);
  });

  it('relays an upstream 429 rate-limit', async () => {
    upstream.setHandler(() => ({ status: 429, body: JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }) }));
    upstream.clearHits();
    const res = await post('/backend/auth/email-verification/resend', {}, selfOrigin(), 'aw_session=SESSION_TOK');
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('rate_limited');
  });

  it('rejects a cross-origin resend with 403 and hits no upstream', async () => {
    upstream.clearHits();
    const res = await post('/backend/auth/email-verification/resend', {}, EVIL_ORIGIN, 'aw_session=SESSION_TOK');
    expect(res.status).toBe(403);
    expect(upstream.hits().length).toBe(0);
  });
});



