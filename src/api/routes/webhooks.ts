/**
 * Webhook ingestion endpoint.
 *
 *   POST /v1/webhooks/:source
 *
 * The tenant is identified by the existing bearer API key (later, provider-
 * specific signature verification will be layered on — see the HMAC note below).
 * The handler is deliberately thin: authenticate, validate the source, derive the
 * idempotency key, and delegate the transaction to `WebhookIngestor`. No business
 * logic or SQL lives here.
 *
 * Responses (the event is always accepted; routing outcome varies):
 *   - new event, workflow matched    → 202 { event_id, run_id, status: "queued" }
 *   - new event, no workflow         → 202 { event_id, run_id: null, status: "accepted",
 *                                            workflow: "not_configured" }
 *   - duplicate delivery             → 200 { event_id, run_id, status: "duplicate" }
 *
 * **HMAC / provider signatures are NOT verified yet.** The raw request body is
 * preserved (`request.rawBody`) precisely so that signature verification can be
 * added at this boundary without a rewrite. Until it is, a bearer key is the only
 * authentication — provider webhooks must not be enabled in production before
 * per-provider signature verification lands.
 */

import { createHash } from 'node:crypto';

import { requireAuth } from '@/api/auth-hook.js';
import { BadRequestError } from '@/api/errors.js';
import type { ApiServer } from '@/api/types.js';
import type { AuthContext } from '@/auth/context.js';
import { webhookSourceSchema } from '@/domain/workflow-trigger.js';
import type { WebhookIngestor } from '@/repositories/webhook-repository.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The exact bytes of the request body, captured before JSON parsing. Present
     * for any request whose body went through the JSON content-type parser.
     * Required for HMAC signature verification later.
     */
    rawBody?: Buffer;
  }
}

/** Builds the tenant-scoped ingestor for an authenticated request. */
export type WebhookIngestorFactory = (auth: AuthContext) => WebhookIngestor;

const EVENT_ID_HEADER = 'x-event-id';

/**
 * Derive the idempotency key: the caller's `X-Event-ID` if present and non-empty,
 * otherwise a SHA-256 of the raw body. Deterministic — the same body always
 * yields the same key — never random.
 */
function deriveDedupeKey(eventIdHeader: string | undefined, rawBody: Buffer): string {
  if (typeof eventIdHeader === 'string' && eventIdHeader.trim() !== '') {
    return eventIdHeader.trim();
  }
  return createHash('sha256').update(rawBody).digest('hex');
}

export function registerWebhookRoutes(app: ApiServer, ingestorFor: WebhookIngestorFactory): void {
  app.post('/v1/webhooks/:source', async (request, reply) => {
    const auth = requireAuth(request);

    const parsedSource = webhookSourceSchema.safeParse((request.params as { source: string }).source);
    if (!parsedSource.success) {
      throw new BadRequestError('Invalid webhook source');
    }
    const source = parsedSource.data;

    // The raw body is captured by the JSON content-type parser. Its absence means
    // no body was sent, which we cannot dedupe or store.
    const rawBody = request.rawBody;
    if (rawBody === undefined || rawBody.length === 0) {
      throw new BadRequestError('A JSON request body is required');
    }

    const eventIdHeader = request.headers[EVENT_ID_HEADER];
    const dedupeKey = deriveDedupeKey(
      Array.isArray(eventIdHeader) ? eventIdHeader[0] : eventIdHeader,
      rawBody,
    );

    const result = await ingestorFor(auth).ingest({
      source,
      dedupeKey,
      payload: request.body,
    });

    if (result.duplicate) {
      return reply.code(200).send({
        event_id: result.eventId,
        run_id: result.runId,
        status: 'duplicate',
      });
    }

    if (result.workflowConfigured) {
      return reply.code(202).send({
        event_id: result.eventId,
        run_id: result.runId,
        status: 'queued',
      });
    }

    return reply.code(202).send({
      event_id: result.eventId,
      run_id: null,
      status: 'accepted',
      workflow: 'not_configured',
    });
  });
}
