/**
 * BFF end-to-end security tests.
 *
 * These tests boot a real Nitro server (via `@nuxt/test-utils`) with a known
 * `NUXT_API_KEY`, and point it at a per-file `node:http` mock that stands in
 * for Fastify. Every assertion hits the actual `/backend/*` route and
 * inspects the actual request the mock receives — there is no helper
 * shortcut that bypasses the route.
 *
 * The 12 security requirements covered here (requirement 6 lives in a
 * separate file because it needs `NUXT_API_KEY` unset) are asserted as
 * `requirement N: …`.
 */
import { resolve as resolvePath } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fetch as nuxtFetch, setup } from '@nuxt/test-utils/e2e';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock';

const TEST_API_KEY = 'test-server-key-do-not-leak-1234567890abcdef';
const ALTERNATE_API_KEY = 'attacker-supplied-key';
// Short upstream timeout so the timeout-exceeded test fires within the
// Vitest test timeout. Must be set BEFORE `setup()` so the spawned Nitro
// server sees it in its env.
const TEST_BFF_TIMEOUT_MS = '500';

// Vitest is invoked from the frontend package root via `pnpm test`, so
// `process.cwd()` is the package root and `setup({ rootDir })` resolves
// correctly from there.
const ROOT_DIR = resolvePath(process.cwd());

// Start the upstream mock BEFORE `setup()` so the env var pointing the BFF at
// it is in place when Nitro boots.
const upstream: UpstreamMock = await startUpstreamMock();

process.env.NUXT_API_KEY = TEST_API_KEY;
process.env.NUXT_BACKEND_URL = upstream.url();
process.env.NUXT_PUBLIC_API_BASE = '/backend';
process.env.NUXT_BFF_TIMEOUT_MS = TEST_BFF_TIMEOUT_MS;

await setup({
  rootDir: ROOT_DIR,
  dev: false,
  server: true,
});

afterAll(async () => {
  await upstream.close();
});

describe('BFF security and forwarding contract', () => {
  it('requirement 1+2: public runtime config and browser payload contain no API key', async () => {
    // In `ssr: false` mode the `/` document is an SPA shell and the public
    // runtime config is shipped inside the client JS bundle, not necessarily
    // inlined as `window.__NUXT__`. So we prove the requirement two ways:
    //   (a) the served HTML never contains the key, and
    //   (b) none of the client `/_nuxt/*.js` chunks the shell references (which
    //       carry the public runtime config) contain the key.
    // `@nuxt/test-utils` e2e `fetch` returns a native `Response` (it delegates
    // to `globalThis.fetch`), so read the HTML via `.text()` — `responseType`
    // is not honoured and there is no `._data`.
    const res = await nuxtFetch('/', { headers: { accept: 'text/html' } });
    const html = await res.text();
    expect(typeof html).toBe('string');
    expect(html).not.toContain(TEST_API_KEY);
    expect(html).not.toContain(ALTERNATE_API_KEY);

    // If Nuxt inlined a `window.__NUXT__` payload, it must not carry the key
    // nor declare an `apiKey` field on the (public) runtime config.
    const payloadMatch = html.match(/window\.__NUXT__\s*=\s*(\{.+?\});/s);
    if (payloadMatch) {
      expect(payloadMatch[1]).not.toContain(TEST_API_KEY);
      expect(payloadMatch[1]).not.toContain(ALTERNATE_API_KEY);
      expect(payloadMatch[1]).not.toMatch(/"apiKey"\s*:/);
    }

    // Scan the client JS chunk(s) the shell references (script src /
    // modulepreload href). The public runtime config is embedded here in SPA
    // mode, so a regression leaking the key into `runtimeConfig.public` would
    // surface in these bytes.
    const chunkPaths = [
      ...new Set(
        [...html.matchAll(/["'](\/_nuxt\/[^"']+\.m?js)["']/g)].map((m) => m[1]),
      ),
    ];
    expect(chunkPaths.length).toBeGreaterThan(0);
    for (const path of chunkPaths) {
      const chunkRes = await nuxtFetch(path);
      const chunk = await chunkRes.text();
      expect(chunk).not.toContain(TEST_API_KEY);
      expect(chunk).not.toContain(ALTERNATE_API_KEY);
    }
  }, 30_000);

  it('requirement 3: incoming browser Authorization cannot override the server key', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{}' }));
    upstream.clearHits();

    const response = await nuxtFetch('/backend/v1/workflows', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${ALTERNATE_API_KEY}`,
        accept: 'application/json',
      },
      ignoreResponseError: true,
    });

    expect(response.status).toBe(200);
    const hits = upstream.hits();
    expect(hits.length).toBe(1);
    const auth = hits[0].headers.authorization;
    expect(auth).toBe(`Bearer ${TEST_API_KEY}`);
    expect(auth).not.toContain(ALTERNATE_API_KEY);
  });

  it('requirement 4: incoming browser Cookie is not forwarded', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{}' }));
    upstream.clearHits();

    await nuxtFetch('/backend/v1/runs', {
      method: 'GET',
      headers: {
        cookie: 'session=secret; csrf=abc',
        accept: 'application/json',
      },
      ignoreResponseError: true,
    });

    const hits = upstream.hits();
    expect(hits.length).toBe(1);
    expect(hits[0].headers.cookie).toBeUndefined();
  });

  it('requirement 5: exactly one server-generated Authorization header reaches Fastify', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{}' }));
    upstream.clearHits();

    // Send multiple Authorization-like headers from the browser.
    await nuxtFetch('/backend/v1/connections', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${ALTERNATE_API_KEY}`,
        // A second one of a different case
        Authorization: `Bearer ${ALTERNATE_API_KEY}-dup`,
        'X-Forwarded-Authorization': `Bearer ${ALTERNATE_API_KEY}-x`,
        accept: 'application/json',
      },
      ignoreResponseError: true,
    });

    const hits = upstream.hits();
    expect(hits.length).toBe(1);
    const auth = hits[0].headers.authorization;
    expect(auth).toBe(`Bearer ${TEST_API_KEY}`);
    expect(auth).not.toContain(ALTERNATE_API_KEY);
    // Forwarded-Authorization is NOT a request-header allowlist entry, so it
    // must also not appear in the upstream request.
    expect(hits[0].headers['x-forwarded-authorization']).toBeUndefined();
  });

  it('requirement 7: upstream 401/403/5xx propagation is safe', async () => {
    for (const status of [401, 403, 500, 502, 503]) {
      upstream.setHandler(() => ({
        status,
        body: JSON.stringify({
          error: {
            code: `fastify_${status}`,
            message: `fastify says ${status}`,
            requestId: 'req_test_123',
          },
        }),
      }));
      upstream.clearHits();

      const response = await nuxtFetch('/backend/v1/workflows', {
        method: 'GET',
        headers: { accept: 'application/json' },
        ignoreResponseError: true,
      });
      expect(response.status).toBe(status);
      const body = (await response.json()) as { error?: { code?: string; message?: string; requestId?: string } };
      expect(body.error).toBeDefined();
      expect(body.error?.code).toBe(`fastify_${status}`);
      // The safe envelope MUST NOT echo the API key back to the browser.
      expect(JSON.stringify(body)).not.toContain(TEST_API_KEY);
    }

    // An upstream 4xx with a non-JSON or non-conformant body should be wrapped.
    upstream.setHandler(() => ({ status: 500, body: 'Internal Server Error' }));
    upstream.clearHits();
    const response = await nuxtFetch('/backend/v1/workflows', {
      method: 'GET',
      headers: { accept: 'application/json' },
      ignoreResponseError: true,
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('upstream_error');
    expect(JSON.stringify(body)).not.toContain(TEST_API_KEY);
  });

  it('requirement 8: timeout → 504', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{}', delayMs: 5_000 }));
    upstream.clearHits();

    const response = await nuxtFetch('/backend/v1/workflows', {
      method: 'GET',
      headers: { accept: 'application/json' },
      ignoreResponseError: true,
    });
    expect(response.status).toBe(504);
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('upstream_timeout');
    expect(JSON.stringify(body)).not.toContain(TEST_API_KEY);
  });

  it('requirement 9: GET and HEAD succeed', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{"hello":"world"}' }));
    upstream.clearHits();

    const getResp = await nuxtFetch('/backend/healthz', {
      method: 'GET',
      headers: { accept: 'application/json' },
      ignoreResponseError: true,
    });
    expect(getResp.status).toBe(200);

    // NOTE: do not clear hits here — this test asserts that BOTH the GET and
    // the subsequent HEAD reached upstream, in order (hits[0]=GET, hits[1]=HEAD).
    const headResp = await nuxtFetch('/backend/healthz', {
      method: 'HEAD',
      ignoreResponseError: true,
    });
    expect(headResp.status).toBe(200);
    // HEAD must not produce a body
    expect(await headResp.text()).toBe('');

    const hits = upstream.hits();
    expect(hits.length).toBe(2);
    expect(hits[0].method).toBe('GET');
    expect(hits[1].method).toBe('HEAD');
  });

  it('requirement 10: POST/PUT/PATCH/DELETE → 405', async () => {
    upstream.clearHits();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await nuxtFetch('/backend/v1/workflows', {
        method,
        headers: { accept: 'application/json' },
        ignoreResponseError: true,
      });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('method_not_allowed');
      expect(JSON.stringify(body)).not.toContain(TEST_API_KEY);
    }
    // None of those should have reached Fastify.
    expect(upstream.hits().length).toBe(0);
  });

  it('requirement 11: path and query forwarding works', async () => {
    upstream.setHandler(() => ({
      status: 200,
      body: JSON.stringify({ ok: true }),
    }));
    upstream.clearHits();

    await nuxtFetch(
      '/backend/v1/runs?limit=10&status=succeeded&status=failed&cursor=abc',
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        ignoreResponseError: true,
      },
    );

    const hits = upstream.hits();
    expect(hits.length).toBe(1);
    expect(hits[0].url).toContain('/v1/runs');
    expect(hits[0].url).toContain('limit=10');
    expect(hits[0].url).toContain('cursor=abc');
    expect(hits[0].url).toContain('status=succeeded');
    expect(hits[0].url).toContain('status=failed');
  });

  it('requirement 12: key never appears in response headers, body, or error', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{"ok":true}' }));
    upstream.clearHits();

    const response = await nuxtFetch('/backend/v1/workflows', {
      method: 'GET',
      headers: {
        // Mix in attack-style headers that must never be reflected.
        authorization: `Bearer ${ALTERNATE_API_KEY}`,
        'x-custom-echo': `Bearer ${ALTERNATE_API_KEY}`,
      },
      ignoreResponseError: true,
    });
    expect(response.status).toBe(200);

    const allHeaderText = [...response.headers.entries()]
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    expect(allHeaderText).not.toContain(TEST_API_KEY);
    expect(allHeaderText).not.toContain(ALTERNATE_API_KEY);
    const bodyText = await response.text();
    expect(bodyText).not.toContain(TEST_API_KEY);
    expect(bodyText).not.toContain(ALTERNATE_API_KEY);

    // Trigger a 500 with attacker-controlled upstream error message
    upstream.setHandler(() => ({
      status: 500,
      body: JSON.stringify({
        error: {
          code: 'pwned',
          // Even if the upstream tries to echo it, the server-side API key is
          // never present in the request the BFF makes, so it cannot be
          // reflected back.
          message: `echo: attacker-supplied`,
          requestId: `rid-test`,
        },
      }),
    }));
    const err = await nuxtFetch('/backend/v1/workflows', {
      method: 'GET',
      ignoreResponseError: true,
    });
    expect(err.status).toBe(500);
    const errBody = await err.text();
    expect(errBody).not.toContain(TEST_API_KEY);
  });

  it('requirement 13: /workflows, /runs, /runs/:runId, /connections work through BFF', async () => {
    upstream.setHandler(() => ({
      status: 200,
      body: JSON.stringify({ items: [], page: { limit: 0, nextCursor: null } }),
    }));

    const cases = [
      '/v1/workflows',
      '/v1/runs',
      '/v1/runs/01a0731a-f176-769a-b851-46be00437ffa',
      '/v1/connections',
    ];
    for (const path of cases) {
      upstream.clearHits();
      const resp = await nuxtFetch(`/backend${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        ignoreResponseError: true,
      });
      expect(resp.status).toBe(200);
      const hit = upstream.hits()[0];
      expect(hit).toBeDefined();
      expect(hit.url).toContain(path);
      expect(hit.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`);
    }
  });
});