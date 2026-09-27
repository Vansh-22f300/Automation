/**
 * BFF returns a safe 503 when NUXT_BACKEND_URL is missing.
 *
 * Lives in its own file because the BFF reads its backend URL from runtime
 * config populated at server start. To exercise the "missing backend" path we
 * must boot a Nitro server whose resolved `NUXT_BACKEND_URL` is empty.
 *
 * Subtlety: Nuxt's config loader (c12) reads `frontend/.env`, and the
 * nuxt.config default for `backendUrl` is a non-empty localhost URL. c12 only
 * *fills in* env vars absent from `process.env` — it does not overwrite ones
 * already set. So we assign an explicit empty string rather than deleting:
 * because the var is present (just empty), `.env` cannot repopulate it, while
 * Nuxt's `applyEnv` still overrides the non-empty config default with `''`, so
 * the BFF's `backendUrl.trim() === ''` gate fires → 503.
 *
 * The API key is intentionally present here: the data plane no longer gates on
 * it (it forwards the human session instead), so a missing key no longer
 * produces a 503 — only a missing backend URL does.
 */
import { resolve as resolvePath } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fetch as nuxtFetch, setup } from '@nuxt/test-utils/e2e';
import { startUpstreamMock, type UpstreamMock } from './helpers/upstream-mock';

const ROOT_DIR = resolvePath(process.cwd());

const upstream: UpstreamMock = await startUpstreamMock();

// Force the resolved backend URL to empty. Assign an empty string (rather than
// `delete`) so c12 will not repopulate it from `frontend/.env` (it only fills
// absent vars); Nuxt's applyEnv still replaces the non-empty config default
// with ''. This drives the BFF's 503 path.
process.env.NUXT_BACKEND_URL = '';
// A machine key is present and valid; it is irrelevant to the data plane now.
process.env.NUXT_API_KEY = 'awk_present-but-unused-by-data-plane-123456';
process.env.NUXT_PUBLIC_API_BASE = '/backend';
process.env.NUXT_BFF_TIMEOUT_MS = '1000';

// A cold Nitro build+boot can exceed the default 240s setup budget on a loaded
// machine; extend it so this single-assertion spec cannot flake on build time.
await setup({ rootDir: ROOT_DIR, dev: false, server: true, setupTimeout: 600_000 });

afterAll(async () => {
  await upstream.close();
});

describe('BFF when NUXT_BACKEND_URL is missing', () => {
  it('returns 503 with a safe envelope, never reaching the (unconfigured) backend', async () => {
    upstream.setHandler(() => ({ status: 200, body: '{}' }));
    upstream.clearHits();

    const response = await nuxtFetch('/backend/v1/workflows', {
      method: 'GET',
      headers: { cookie: 'aw_session=some-session-token', accept: 'application/json' },
      ignoreResponseError: true,
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('bff_unconfigured');
    expect(body.error?.message).toBeDefined();
    // The envelope must not echo any credential.
    expect(JSON.stringify(body)).not.toMatch(/awk_/);
    expect(JSON.stringify(body)).not.toContain('some-session-token');

    // The upstream must not have been called.
    expect(upstream.hits().length).toBe(0);
  });
});
