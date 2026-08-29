/**
 * HTTP-boundary tests for the webhook ingestion route.
 *
 * These drive the real `buildApp` via `app.inject` with a fake authenticator and
 * a recording fake ingestor, so the whole request pipeline — auth hook, the raw-
 * body content-type parser, dedupe-key derivation, source validation, response
 * mapping — is exercised with no database. What the *service* does inside its
 * transaction is covered by the integration suite; here we prove the boundary.
 */

import { createHash } from 'node:crypto';

import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/api/app.js';
import { UnauthorizedError } from '@/api/errors.js';
import type { ApiServer } from '@/api/types.js';
import type { AuthContext, Authenticator } from '@/auth/context.js';
import { newId } from '@/domain/ids.js';
import type { IngestInput, IngestResult, WebhookIngestor } from '@/repositories/webhook-repository.js';

const VALID_KEY = 'valid-key';
const TENANT = 'tenant-1';

const authenticator: Authenticator = {
  authenticate: async (credential: string): Promise<AuthContext> => {
    if (credential !== VALID_KEY) throw new UnauthorizedError();
    return { tenantId: TENANT, apiKeyId: 'key-1' };
  },
};

/** Records every ingest call and returns a programmable result. */
class RecordingIngestor implements WebhookIngestor {
  readonly calls: IngestInput[] = [];
  next: IngestResult = {
    eventId: newId(),
    runId: null,
    duplicate: false,
    workflowConfigured: false,
  };

  ingest = async (input: IngestInput): Promise<IngestResult> => {
    this.calls.push(input);
    return this.next;
  };
}

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

interface Harness {
  app: ApiServer;
  ingestor: RecordingIngestor;
}

async function makeApp(): Promise<Harness> {
  const ingestor = new RecordingIngestor();
  const app = await buildApp({
    logger: silentLogger(),
    authenticator,
    checkDatabase: async () => undefined,
    apiKeyServiceFor: () => {
      throw new Error('not used');
    },
    webhookIngestorFor: () => ingestor,
  });
  return { app, ingestor };
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

let current: Harness | undefined;
afterEach(async () => {
  if (current !== undefined) {
    await current.app.close();
    current = undefined;
  }
});

describe('POST /v1/webhooks/:source — authentication', () => {
  it('rejects a missing API key with 401', async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: 'POST',
      url: '/v1/webhooks/test',
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(401);
    expect(current.ingestor.calls).toHaveLength(0);
  });

  it('rejects an invalid API key with 401', async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: 'POST',
      url: '/v1/webhooks/test',
      headers: bearer('nope'),
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/webhooks/:source — responses', () => {
  it('returns 202 queued when a workflow matched', async () => {
    current = await makeApp();
    current.ingestor.next = {
      eventId: 'ev-1',
      runId: 'run-1',
      duplicate: false,
      workflowConfigured: true,
    };
    const res = await current.app.inject({
      method: 'POST',
      url: '/v1/webhooks/test',
      headers: bearer(VALID_KEY),
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ event_id: 'ev-1', run_id: 'run-1', status: 'queued' });
  });

  it('returns 202 accepted/not_configured when no workflow matched', async () => {
    current = await makeApp();
    current.ingestor.next = {
      eventId: 'ev-2',
      runId: null,
      duplicate: false,
      workflowConfigured: false,
    };
    const res = await current.app.inject({
      method: 'POST',
      url: '/v1/webhooks/test',
      headers: bearer(VALID_KEY),
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      event_id: 'ev-2',
      run_id: null,
      status: 'accepted',
      workflow: 'not_configured',
    });
  });

  it('returns 200 duplicate for a repeated delivery', async () => {
    current = await makeApp();
    current.ingestor.next = {
      eventId: 'ev-3',
      runId: 'run-3',
      duplicate: true,
      workflowConfigured: true,
    };
    const res = await current.app.inject({
      method: 'POST',
      url: '/v1/webhooks/test',
      headers: bearer(VALID_KEY),
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ event_id: 'ev-3', run_id: 'run-3', status: 'duplicate' });
  });
});

describe('POST /v1/webhooks/:source — dedupe key derivation', () => {
  it('uses X-Event-ID as the dedupe key when provided', async () => {
    current = await makeApp();
    await current.app.inject({
      method: 'POST',
      url: '/v1/webhooks/test',
      headers: { ...bearer(VALID_KEY), 'x-event-id': 'evt-abc' },
      payload: { a: 1 },
    });
    expect(current.ingestor.calls[0]!.dedupeKey).toBe('evt-abc');
  });

  it('falls back to a SHA-256 of the raw body when no X-Event-ID', async () => {
    current = await makeApp();
    const body = JSON.stringify({ a: 1, b: 2 });
    await current.app.inject({
      method: 'POST',
      url: '/v1/webhooks/test',
      headers: { ...bearer(VALID_KEY), 'content-type': 'application/json' },
      payload: body,
    });
    const expected = createHash('sha256').update(Buffer.from(body)).digest('hex');
    expect(current.ingestor.calls[0]!.dedupeKey).toBe(expected);
  });

  it('derives the same key for identical raw bodies and different keys for different bodies', async () => {
    current = await makeApp();
    const send = (payload: string) =>
      current!.app.inject({
        method: 'POST',
        url: '/v1/webhooks/test',
        headers: { ...bearer(VALID_KEY), 'content-type': 'application/json' },
        payload,
      });
    await send('{"a":1}');
    await send('{"a":1}');
    await send('{"a":2}');
    const [k1, k2, k3] = current.ingestor.calls.map((c) => c.dedupeKey);
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('passes the parsed payload and validated source through', async () => {
    current = await makeApp();
    await current.app.inject({
      method: 'POST',
      url: '/v1/webhooks/github',
      headers: bearer(VALID_KEY),
      payload: { hello: 'world' },
    });
    expect(current.ingestor.calls[0]!.source).toBe('github');
    expect(current.ingestor.calls[0]!.payload).toEqual({ hello: 'world' });
  });
});

describe('POST /v1/webhooks/:source — validation and limits', () => {
  it('rejects an invalid source with 400', async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: 'POST',
      url: '/v1/webhooks/Bad_Source!',
      headers: bearer(VALID_KEY),
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(current.ingestor.calls).toHaveLength(0);
  });

  it('rejects malformed JSON with 400', async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: 'POST',
      url: '/v1/webhooks/test',
      headers: { ...bearer(VALID_KEY), 'content-type': 'application/json' },
      payload: '{ not valid json',
    });
    expect(res.statusCode).toBe(400);
    expect(current.ingestor.calls).toHaveLength(0);
  });

  it('rejects an empty body with 400', async () => {
    current = await makeApp();
    const res = await current.app.inject({
      method: 'POST',
      url: '/v1/webhooks/test',
      headers: { ...bearer(VALID_KEY), 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an oversized body (over the 1 MiB limit)', async () => {
    current = await makeApp();
    const big = JSON.stringify({ blob: 'x'.repeat(1_100_000) });
    const res = await current.app.inject({
      method: 'POST',
      url: '/v1/webhooks/test',
      headers: { ...bearer(VALID_KEY), 'content-type': 'application/json' },
      payload: big,
    });
    expect(res.statusCode).toBe(413);
    expect(current.ingestor.calls).toHaveLength(0);
  });
});
