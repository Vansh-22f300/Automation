/**
 * Webhook ingestion endpoint.
 *
 *   POST /v1/webhooks/:source
 *
 * The tenant is identified by the existing bearer API key. When the active webhook
 * version for `(tenant, source)` carries a `signature` configuration, every delivery
 * is verified against the configured HMAC (with the timestamp IN the signed bytes
 * when `signing_input = "timestamp_and_body"`) BEFORE any DB work happens. Failed
 * verification is a 401 with a generic message and a structured log entry that
 * records only the reason code and the lengths of the inputs — never the body,
 * signature, or secret.
 *
 * The handler is deliberately thin: authenticate, validate the source, verify
 * signature if required, derive the idempotency key, and delegate the transaction to
 * `WebhookIngestor`. No business logic or SQL lives here.
 *
 * Responses (the event is accepted only after signature verification succeeds):
 *   - new event, workflow matched    → 202 { event_id, run_id, status: "queued" }
 *   - new event, no workflow         → 202 { event_id, run_id: null, status: "accepted",
 *                                            workflow: "not_configured" }
 *   - duplicate delivery             → 200 { event_id, run_id, status: "duplicate" }
 *   - signature verification refused → 401 { error: { code, message, requestId } }
 *
 * **HMAC modes** supported by the underlying config (`src/domain/webhook-signature.ts`):
 *   - `raw_body`           — HMAC-SHA256(key, rawBody)
 *   - `timestamp_and_body` — HMAC-SHA256(key, canonicalTimestamp || "." || rawBody)
 *
 * **Replay terminology (precise):**
 *   - `timestamp_and_body` provides an **authenticated timestamp** and
 *     **freshness / tolerance enforcement**: a captured delivery cannot be replayed
 *     outside the configured `tolerance_seconds` window, and the timestamp
 *     cannot be substituted without invalidating the signature.
 *   - It does NOT, on its own, prevent exact-duplicate replays of the same
 *     `(timestamp, body, signature)` within the window. Suppression of such
 *     duplicates is handled by the `X-Event-ID` dedupe layer; that layer is
 *     caller-controlled and is a known separate concern from signature verification.
 *
 * The signed bytes are computed and documented in `@/domain/webhook-signature`.
 */

import { createHash } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import { requireAuth } from '@/api/auth-hook.js';
import { BadRequestError, UnauthorizedError } from '@/api/errors.js';
import type { ApiServer } from '@/api/types.js';
import type { AuthContext } from '@/auth/context.js';
import {
  nodeHeaderLookup,
  verifyWebhookSignature,
} from '@/domain/webhook-signature.js';
import { webhookSourceSchema } from '@/domain/workflow-trigger.js';
import type {
  WebhookSignatureResolver,
} from '@/repositories/webhook-signature-resolver.js';
import { WebhookSignatureSecretUnavailableError } from '@/repositories/webhook-signature-resolver.js';
import type { WebhookIngestor } from '@/repositories/webhook-repository.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The exact bytes of the request body, captured before JSON parsing. Present
     * for any request whose body went through the JSON content-type parser.
     * Required for HMAC signature verification.
     */
    rawBody?: Buffer;
  }
}

/** Builds the tenant-scoped ingestor for an authenticated request. */
export type WebhookIngestorFactory = (auth: AuthContext) => WebhookIngestor;

/** Builds the tenant-scoped signature resolver for an authenticated request. */
export type WebhookSignatureResolverFactory = (
  auth: AuthContext,
) => WebhookSignatureResolver;

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

/**
 * Read and verify a webhook signature, if one is required for this source.
 *
 * Returns `null` when no signature verification is required for the source (the
 * legacy behavior). Raises `UnauthorizedError` when verification is required and
 * fails for any reason; the error message is a single generic string regardless
 * of the underlying reason, and the structured reason code is logged separately.
 *
 * The raw body, the signature value, and the secret are never logged. Lengths
 * and a reason code are the only operator-visible signals.
 */
async function enforceSignatureIfRequired(
  request: FastifyRequest,
  source: string,
  rawBody: Buffer,
  resolver: WebhookSignatureResolver,
): Promise<void> {
  let material;
  try {
    material = await resolver.resolveForSource(source);
  } catch (error) {
    if (error instanceof WebhookSignatureSecretUnavailableError) {
      request.log.warn(
        {
          source,
          reason: error.code,
        },
        'webhook signature verification refused: signing material unavailable',
      );
    } else {
      request.log.error(
        {
          source,
          err: error instanceof Error ? error.message : 'unknown error',
        },
        'webhook signature resolver failed unexpectedly',
      );
    }
    throw new UnauthorizedError('Webhook signature verification failed');
  }
  // No signature configured for this source — preserve legacy behavior.
  if (material === null) {
    return;
  }

  const result = verifyWebhookSignature(
    {
      rawBody,
      headers: nodeHeaderLookup(request.headers),
      now: new Date(),
    },
    material.config,
    material.secret,
  );

  if (result.outcome === 'valid') {
    return;
  }
  // verification failed — log the reason + lengths, never the inputs themselves.
  request.log.warn(
    {
      source,
      reason: result.reason,
      signing_input: material.config.signing_input,
      raw_body_length: rawBody.length,
    },
    'webhook signature verification refused',
  );
  // Tell the client nothing about which guard fired.
  throw new UnauthorizedError('Webhook signature verification failed');
}

export function registerWebhookRoutes(
  app: ApiServer,
  ingestorFor: WebhookIngestorFactory,
  resolverFor: WebhookSignatureResolverFactory,
): void {
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

    // Signature verification (if configured for the source) happens BEFORE any
    // dedupe-key derivation or transaction begins. A failed signature means no
    // event is persisted, exactly like a failed bearer key.
    await enforceSignatureIfRequired(
      request,
      source,
      rawBody,
      resolverFor(auth),
    );

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
