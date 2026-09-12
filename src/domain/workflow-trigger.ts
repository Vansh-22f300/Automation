/**
 * Trigger configuration — how a workflow version gets started.
 *
 * Kept intentionally minimal: the only trigger that exists in the MVP is a
 * webhook, so this is a single validated shape, not a generic trigger framework.
 * It pairs with `workflow_versions.trigger_type` (the enum) and
 * `workflow_versions.trigger_config` (the JSON document validated here).
 *
 * Webhook ingestion itself — the endpoint, signature checks, event persistence —
 * is Step 4B. This module only defines and validates the stored configuration so
 * that a version can *declare* it now.
 */

import { z } from 'zod';

import { webhookSignatureConfigSchema } from '@/domain/webhook-signature.js';

/** The trigger kinds that exist. Only `webhook` today; mirrors the DB enum. */
export const SUPPORTED_TRIGGER_TYPES = ['webhook'] as const;
export type TriggerType = (typeof SUPPORTED_TRIGGER_TYPES)[number];

/**
 * A `source` is a safe, non-empty identifier naming who is expected to call the
 * webhook (e.g. `stripe`, `github`, `test`). Constrained to the same identifier
 * shape used elsewhere so it is predictable in URLs, logs and lookups rather than
 * free text.
 */
export const TRIGGER_SOURCE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * The `source` identifier on its own. Exported so the webhook route can validate
 * the `:source` path segment with the *same* rule the stored trigger config uses
 * — one definition of "safe source", not two that can drift.
 */
export const webhookSourceSchema = z
  .string()
  .regex(
    TRIGGER_SOURCE_PATTERN,
    'source must be a lowercase identifier (a-z, 0-9, _, -), starting with a letter',
  );

/**
 * Per-source webhook configuration. The `signature` field is optional: a source
 * without it behaves exactly as before (no signature verification at the boundary,
 * bearer-key remains the only authentication). When present, the route layer
 * loads the secret from the configured connection and verifies the request
 * signature per `src/domain/webhook-signature.ts`.
 *
 * `.strict()` rejects unknown fields so a misspelled key does not silently fall
 * back to a verifier with a relaxed policy.
 */
export const webhookTriggerConfigSchema = z
  .object({
    source: webhookSourceSchema,
    signature: webhookSignatureConfigSchema.optional(),
  })
  .strict();

export type WebhookTriggerConfig = z.infer<typeof webhookTriggerConfigSchema>;

/**
 * The per-type config schemas. A map keyed by trigger type so the service can
 * validate `trigger_config` against whichever `trigger_type` a version declares,
 * and so adding a trigger kind later is one new entry.
 */
const triggerConfigByType = {
  webhook: webhookTriggerConfigSchema,
} as const;

export type TriggerConfig = WebhookTriggerConfig;

/**
 * Validate a `(type, config)` pair. Returns the validated config or throws
 * `ZodError`. The `type` is validated against the supported set first, so an
 * unsupported trigger type is rejected before its config is even inspected.
 */
export function parseTriggerConfig(type: TriggerType, config: unknown): TriggerConfig {
  return triggerConfigByType[type].parse(config);
}
