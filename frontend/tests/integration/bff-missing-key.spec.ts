/**
 * Requirement 6: missing NUXT_API_KEY → 503 safe error.
 *
 * Lives in its own file because the BFF reads the API key from runtime config
 * populated at server start. To exercise the "missing key" path we must boot a
 * Nitro server whose resolved `NUXT_API_KEY` is empty.
 *
 * Subtlety: Nuxt's config loader (c12) reads `frontend/.env`, which in this
 * checkout defines a real `NUXT_API_KEY`. c12 only *fills in* env vars that are
 * absent from `process.env` — it does not overwrite ones already set (see
 * c12's dotenv loader: `if (key in environment && !dotenvVars.has(key))
 * continue`). So we set `NUXT_API_KEY` to an explicit empty string rather than
 * deleting it: because the var is present (just empty), `.env` cannot
 * repopulate it, and the BFF's `apiKey.trim() === ''` gate fires → 503.
 *
 * This does not rely on per-file `process.env` isolation (the suites share one
 * fork under `singleFork`); each spec sets its own `NUXT_API_KEY` at top level
 * before its own `setup()`, so the value in effect when each server boots is
 * that file's value.
 */
import { resolve as resolvePath } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fetch as nuxtFetch, setup } from '@nuxt/test-utils/e2e';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock';

const ROOT_DIR = resolvePath(process.cwd());

const upstream: UpstreamMock = await startUpstreamMock();

// Force the resolved server key to empty. We assign an empty string (rather
// than `delete`) so c12's dotenv loader will not repopulate it from
// `frontend/.env` (it only fills absent vars). This drives the BFF's 503 path.
process.env.NUXT_API_KEY = '';
process.env.NUXT_BACKEND_URL = upstream.url();
process.env.NUXT_PUBLIC_API_BASE = '/backend';
process.env.NUXT_BFF_TIMEOUT_MS = '1000';

await setup({
  rootDir: ROOT_DIR,
  dev: false,
  server: true,
});

afterAll(async () => {
  await upstream.close();
});

describe('BFF when NUXT_API_KEY is missing', () => {
  it('requirement 6: returns 503 with a safe envelope, never reaching Fastify', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{}' }));
    upstream.clearHits();

    const response = await nuxtFetch('/backend/v1/workflows', {
      method: 'GET',
      headers: { accept: 'application/json' },
      ignoreResponseError: true,
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('bff_unconfigured');
    expect(body.error?.message).toBeDefined();
    // The envelope must not echo any API key.
    expect(JSON.stringify(body)).not.toMatch(/awk_/);
    expect(JSON.stringify(body)).not.toContain('NUXT_API_KEY');

    // The upstream must not have been called.
    expect(upstream.hits().length).toBe(0);
  });
});