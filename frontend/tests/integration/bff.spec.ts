/**
 * BFF data-plane end-to-end security tests.
 *
 * These tests boot a real Nitro server (via `@nuxt/test-utils`) and point it at
 * a per-file `node:http` mock that stands in for Fastify. Every assertion hits
 * the actual `/backend/*` route and inspects the actual request the mock
 * receives — there is no helper shortcut that bypasses the route.
 *
 * The milestone under test makes the *human session* — not the machine API key
 * — the credential the data plane forwards. The BFF reads the HttpOnly
 * `aw_session` cookie server-side and injects `Authorization: Bearer <session
 * token>`; with no cookie it forwards no Authorization at all (Fastify then
 * decides). A machine API key is configured in `NUXT_API_KEY` precisely so
 * these tests can prove it is NEVER forwarded on this plane.
 */
import { resolve as resolvePath } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fetch as nuxtFetch, setup } from '@nuxt/test-utils/e2e';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock';

// A machine API key is configured but must NEVER be forwarded on the data
// plane. Shaped like a real key (`awk_` prefix) so a regression that fell back
// to it would be caught by the "never forwarded" assertions.
const MACHINE_KEY = 'awk_machine-key-should-never-be-forwarded-1234567890';
// The human's opaque session token — what the BFF SHOULD forward, read from the
// HttpOnly `aw_session` cookie. Deliberately has no `awk_` prefix.
const SESSION_TOKEN = 'session-opaque-token-Do-Not-Leak-1234567890abcdef';
// A bearer the browser tries to smuggle in via a request header. Must never
// reach Fastify: the server chooses the credential, not the caller.
const ATTACKER_BEARER = 'attacker-supplied-bearer-value';
// Short upstream timeout so the timeout-exceeded test fires within the Vitest
// test timeout. Must be set BEFORE `setup()` so the spawned Nitro server sees it.
const TEST_BFF_TIMEOUT_MS = '500';

const ROOT_DIR = resolvePath(process.cwd());

// Start the upstream mock BEFORE `setup()` so the env var pointing the BFF at
// it is in place when Nitro boots.
const upstream: UpstreamMock = await startUpstreamMock();

process.env.NUXT_API_KEY = MACHINE_KEY;
process.env.NUXT_BACKEND_URL = upstream.url();
process.env.NUXT_PUBLIC_API_BASE = '/backend';
process.env.NUXT_BFF_TIMEOUT_MS = TEST_BFF_TIMEOUT_MS;

// Building and booting a real Nitro server can take several minutes on a cold,
// loaded machine; give `setup()` a generous budget so a slow build never flakes
// these security assertions (the default 240s can be exceeded here).
await setup({ rootDir: ROOT_DIR, dev: false, server: true, setupTimeout: 600_000 });

afterAll(async () => {
  await upstream.close();
});

// The Cookie header carrying the human session.
const SESSION_COOKIE = `aw_session=${SESSION_TOKEN}`;
describe('BFF data-plane security and forwarding contract', () => {
  it('the machine key and session token never appear in served HTML or client bundle', async () => {
    const res = await nuxtFetch('/', { headers: { accept: 'text/html' } });
    const html = await res.text();
    expect(typeof html).toBe('string');
    expect(html).not.toContain(MACHINE_KEY);
    expect(html).not.toContain(SESSION_TOKEN);

    const payloadMatch = html.match(/window\.__NUXT__\s*=\s*(\{.+?\});/s);
    if (payloadMatch) {
      expect(payloadMatch[1]).not.toContain(MACHINE_KEY);
      expect(payloadMatch[1]).not.toContain(SESSION_TOKEN);
      expect(payloadMatch[1]).not.toMatch(/"apiKey"\s*:/);
    }

    const chunkPaths = [
      ...new Set([...html.matchAll(/["'](\/_nuxt\/[^"']+\.m?js)["']/g)].map((m) => m[1])),
    ];
    expect(chunkPaths.length).toBeGreaterThan(0);
    for (const path of chunkPaths) {
      const chunkRes = await nuxtFetch(path);
      const chunk = await chunkRes.text();
      expect(chunk).not.toContain(MACHINE_KEY);
      expect(chunk).not.toContain(SESSION_TOKEN);
    }
  }, 30_000);

  it('forwards the human session token from the aw_session cookie as the upstream bearer', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{}' }));
    upstream.clearHits();

    const response = await nuxtFetch('/backend/v1/workflows', {
      method: 'GET',
      headers: { cookie: SESSION_COOKIE, accept: 'application/json' },
      ignoreResponseError: true,
    });

    expect(response.status).toBe(200);
    const hits = upstream.hits();
    expect(hits.length).toBe(1);
    expect(hits[0].headers.authorization).toBe(`Bearer ${SESSION_TOKEN}`);
    // The machine key must never be the forwarded credential.
    expect(hits[0].headers.authorization).not.toContain(MACHINE_KEY);
  });
  it('forwards no Authorization header when there is no session cookie', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{}' }));
    upstream.clearHits();

    await nuxtFetch('/backend/v1/workflows', {
      method: 'GET',
      headers: { accept: 'application/json' },
      ignoreResponseError: true,
    });

    const hits = upstream.hits();
    expect(hits.length).toBe(1);
    // No cookie ⇒ nothing to forward. Fastify's /v1/* guard then 401s; the BFF
    // must not fall back to the machine key.
    expect(hits[0].headers.authorization).toBeUndefined();
  });

  it('a browser-supplied Authorization header cannot override the session credential', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{}' }));
    upstream.clearHits();

    const response = await nuxtFetch('/backend/v1/workflows', {
      method: 'GET',
      headers: {
        cookie: SESSION_COOKIE,
        authorization: `Bearer ${ATTACKER_BEARER}`,
        accept: 'application/json',
      },
      ignoreResponseError: true,
    });

    expect(response.status).toBe(200);
    const hits = upstream.hits();
    expect(hits.length).toBe(1);
    const auth = hits[0].headers.authorization;
    expect(auth).toBe(`Bearer ${SESSION_TOKEN}`);
    expect(auth).not.toContain(ATTACKER_BEARER);
    expect(auth).not.toContain(MACHINE_KEY);
  });

  it('reads the session cookie server-side but never forwards the raw Cookie upstream', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{}' }));
    upstream.clearHits();

    await nuxtFetch('/backend/v1/runs', {
      method: 'GET',
      headers: {
        cookie: `${SESSION_COOKIE}; other=secret; csrf=abc`,
        accept: 'application/json',
      },
      ignoreResponseError: true,
    });

    const hits = upstream.hits();
    expect(hits.length).toBe(1);
    // The cookie header is not on the forward allowlist ⇒ stripped …
    expect(hits[0].headers.cookie).toBeUndefined();
    // … but its aw_session value became the server-derived bearer.
    expect(hits[0].headers.authorization).toBe(`Bearer ${SESSION_TOKEN}`);
  });
  it('sends exactly one server-chosen Authorization and strips tenant/identity headers', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{}' }));
    upstream.clearHits();

    await nuxtFetch('/backend/v1/connections', {
      method: 'GET',
      headers: {
        cookie: SESSION_COOKIE,
        authorization: `Bearer ${ATTACKER_BEARER}`,
        Authorization: `Bearer ${ATTACKER_BEARER}-dup`,
        'X-Forwarded-Authorization': `Bearer ${ATTACKER_BEARER}-x`,
        'X-Tenant-Id': 'tenant-the-browser-picked',
        'X-User-Id': 'user-the-browser-picked',
        accept: 'application/json',
      },
      ignoreResponseError: true,
    });

    const hits = upstream.hits();
    expect(hits.length).toBe(1);
    const auth = hits[0].headers.authorization;
    expect(auth).toBe(`Bearer ${SESSION_TOKEN}`);
    expect(auth).not.toContain(ATTACKER_BEARER);
    // None of these caller-chosen identity/authorization headers are on the
    // request allowlist, so none can reach Fastify to influence the tenant.
    expect(hits[0].headers['x-forwarded-authorization']).toBeUndefined();
    expect(hits[0].headers['x-tenant-id']).toBeUndefined();
    expect(hits[0].headers['x-user-id']).toBeUndefined();
  });

  it('propagates upstream 401/403/5xx safely without leaking credentials', async () => {
    for (const status of [401, 403, 500, 502, 503]) {
      upstream.setHandler(() => ({
        status,
        body: JSON.stringify({
          error: { code: `fastify_${status}`, message: `fastify says ${status}`, requestId: 'req_test_123' },
        }),
      }));
      upstream.clearHits();

      const response = await nuxtFetch('/backend/v1/workflows', {
        method: 'GET',
        headers: { cookie: SESSION_COOKIE, accept: 'application/json' },
        ignoreResponseError: true,
      });
      expect(response.status).toBe(status);
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe(`fastify_${status}`);
      expect(JSON.stringify(body)).not.toContain(MACHINE_KEY);
      expect(JSON.stringify(body)).not.toContain(SESSION_TOKEN);
    }

    upstream.setHandler(() => ({ status: 500, body: 'Internal Server Error' }));
    upstream.clearHits();
    const response = await nuxtFetch('/backend/v1/workflows', {
      method: 'GET',
      headers: { cookie: SESSION_COOKIE, accept: 'application/json' },
      ignoreResponseError: true,
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('upstream_error');
  });
  it('returns 504 when the upstream exceeds the timeout', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{}', delayMs: 5_000 }));
    upstream.clearHits();

    const response = await nuxtFetch('/backend/v1/workflows', {
      method: 'GET',
      headers: { cookie: SESSION_COOKIE, accept: 'application/json' },
      ignoreResponseError: true,
    });
    expect(response.status).toBe(504);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('upstream_timeout');
  });

  it('GET and HEAD both reach upstream and HEAD returns no body', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{"hello":"world"}' }));
    upstream.clearHits();

    const getResp = await nuxtFetch('/backend/healthz', {
      method: 'GET',
      headers: { accept: 'application/json' },
      ignoreResponseError: true,
    });
    expect(getResp.status).toBe(200);

    // Do not clear hits: assert BOTH the GET and the HEAD reached upstream, in
    // order (hits[0]=GET, hits[1]=HEAD).
    const headResp = await nuxtFetch('/backend/healthz', { method: 'HEAD', ignoreResponseError: true });
    expect(headResp.status).toBe(200);
    expect(await headResp.text()).toBe('');

    const hits = upstream.hits();
    expect(hits.length).toBe(2);
    expect(hits[0].method).toBe('GET');
    expect(hits[1].method).toBe('HEAD');
  });

  it('rejects POST/PUT/PATCH/DELETE with 405 and never reaches upstream', async () => {
    upstream.clearHits();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await nuxtFetch('/backend/v1/workflows', {
        method,
        headers: { cookie: SESSION_COOKIE, accept: 'application/json' },
        ignoreResponseError: true,
      });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('method_not_allowed');
    }
    expect(upstream.hits().length).toBe(0);
  });
  it('forwards the path and query string to upstream', async () => {
    upstream.setHandler(() => ({ status: 200, body: JSON.stringify({ ok: true }) }));
    upstream.clearHits();

    await nuxtFetch('/backend/v1/runs?limit=10&status=succeeded&status=failed&cursor=abc', {
      method: 'GET',
      headers: { cookie: SESSION_COOKIE, accept: 'application/json' },
      ignoreResponseError: true,
    });

    const hits = upstream.hits();
    expect(hits.length).toBe(1);
    expect(hits[0].url).toContain('/v1/runs');
    expect(hits[0].url).toContain('limit=10');
    expect(hits[0].url).toContain('cursor=abc');
    expect(hits[0].url).toContain('status=succeeded');
    expect(hits[0].url).toContain('status=failed');
  });

  it('never reflects any credential in response headers or body', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{"ok":true}' }));
    upstream.clearHits();

    const response = await nuxtFetch('/backend/v1/workflows', {
      method: 'GET',
      headers: {
        cookie: SESSION_COOKIE,
        authorization: `Bearer ${ATTACKER_BEARER}`,
        'x-custom-echo': `Bearer ${ATTACKER_BEARER}`,
      },
      ignoreResponseError: true,
    });
    expect(response.status).toBe(200);

    const allHeaderText = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
    expect(allHeaderText).not.toContain(MACHINE_KEY);
    expect(allHeaderText).not.toContain(SESSION_TOKEN);
    expect(allHeaderText).not.toContain(ATTACKER_BEARER);
    const bodyText = await response.text();
    expect(bodyText).not.toContain(MACHINE_KEY);
    expect(bodyText).not.toContain(SESSION_TOKEN);
  });

  it('serves /workflows, /runs, /runs/:runId, /connections forwarding the session bearer', async () => {
    upstream.setHandler(() => ({
      status: 200,
      body: JSON.stringify({ items: [], page: { limit: 0, nextCursor: null } }),
    }));

    const cases = ['/v1/workflows', '/v1/runs', '/v1/runs/01a0731a-f176-769a-b851-46be00437ffa', '/v1/connections'];
    for (const path of cases) {
      upstream.clearHits();
      const resp = await nuxtFetch(`/backend${path}`, {
        method: 'GET',
        headers: { cookie: SESSION_COOKIE, accept: 'application/json' },
        ignoreResponseError: true,
      });
      expect(resp.status).toBe(200);
      const hit = upstream.hits()[0];
      expect(hit).toBeDefined();
      expect(hit.url).toContain(path);
      expect(hit.headers.authorization).toBe(`Bearer ${SESSION_TOKEN}`);
    }
  });
});
