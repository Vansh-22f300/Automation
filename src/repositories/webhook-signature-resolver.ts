/**
 * Tenant-scoped lookup of webhook signature config and the signing secret that goes
 * with it.
 *
 * The resolver is read-only: it performs a single (small) query against the
 * `workflow_versions` view of the active webhook version for a `(tenant, source)`
 * pair, parses the stored trigger config through the same Zod schema every
 * workflow write goes through, and then — only if the config is configured for
 * signing — resolves the secret from the connection named by `secret_connection_id`.
 *
 * The path is deliberately separate from `WebhookRepository.ingest`: signature
 * verification is an *authentication* concern that runs before any DB write,
 * exactly like the bearer-key check, and failing it must not produce an event
 * row, a run row, or a `jobs` row. Mirroring the tool-side resolver, the secret
 * is decrypted only here, only after the connection is confirmed `active`, and
 * is held only for the lifetime of the verifier call.
 *
 * Pure read-only DB queries and one decrypt operation. No business logic. The
 * verifier itself lives in `src/domain/webhook-signature.ts` and is pure.
 */

import { and, eq, sql } from 'drizzle-orm';

import type { AuthContext } from '@/auth/context.js';
import { connections, workflowVersions } from '@/db/schema.js';
import type { WebhookSignatureConfig } from '@/domain/webhook-signature.js';
import { parseTriggerConfig } from '@/domain/workflow-trigger.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import {
  CredentialCipher,
} from '@/security/credential-cipher.js';
import type { EncryptedEnvelope } from '@/security/credential-cipher.js';

/**
 * Non-secret facts the route can log about a resolved signing config. Lengths are
 * the only sizes reported — the secret, the signature, and the body never appear
 * here, and the connection id is included only because it is the configured
 * reference, not a credential.
 */
export interface ResolvedSigningMaterial {
  readonly config: WebhookSignatureConfig;
  /** Bytes of the decrypted shared secret. Never logged, never returned. */
  readonly secret: string;
}

/**
 * The seam the webhook route depends on. Implementations are tenant-scoped: a
 * resolver built for tenant A cannot be asked about tenant B's source.
 */
export interface WebhookSignatureResolver {
  /**
   * Look up the active webhook version's `signature` configuration for a source.
   *
   * - Returns `null` if no active workflow version exists for the source, OR the
   *   active version has no `signature` sub-config. The route treats `null` as
   *   "no signature verification required for this source" — the legacy behavior.
   * - Returns the resolved config + decrypted secret when a signature is configured.
   * - Throws an `Error` (caught by the route and turned into a 401) when the
   *   configured signing material is unavailable: the connection is missing, has
   *   been disabled, the connection is for a different tenant, or the decrypted
   *   credential has no string `secret` field.
   *
   * The returned secret is held only for the lifetime of the caller's verifier
   * invocation. No implementation caches it.
   */
  resolveForSource(source: string): Promise<ResolvedSigningMaterial | null>;
}

/**
 * The single implementation: a tenant-scoped read-only path over Drizzle that
 * reuses the existing connection-cipher decrypt primitive. Per-request, no shared
 * mutable state.
 */
export class WebhookSignatureRepository implements WebhookSignatureResolver {
  constructor(
    private readonly scope: TenantScope,
    private readonly cipher: CredentialCipher,
  ) {}

  async resolveForSource(source: string): Promise<ResolvedSigningMaterial | null> {
    // The single active webhook version for this tenant + source, if any. The
    // partial unique index on `(tenant_id, trigger_config->>'source') WHERE
    // is_active` makes at most one row possible.
    const [version] = await this.scope.db
      .select({
        triggerConfig: workflowVersions.triggerConfig,
      })
      .from(workflowVersions)
      .where(
        and(
          this.scope.where(workflowVersions.tenantId),
          eq(workflowVersions.isActive, true),
          eq(workflowVersions.triggerType, 'webhook'),
          sql`${workflowVersions.triggerConfig} ->> 'source' = ${source}`,
        ),
      )
      .limit(1);

    if (version === undefined) {
      // No active version for this source, so no signature is configured.
      return null;
    }

    // Parse the stored JSON through the same Zod schema authoring uses. A stored
    // row that does not satisfy the schema is an operator / data bug we surface
    // rather than silently treat as "no signature".
    const parsed = parseTriggerConfig('webhook', version.triggerConfig);
    const config = parsed.signature;
    if (config === undefined) {
      return null;
    }

    // Resolve the signing secret from the configured connection. Same tenant,
    // status `active`, and the decrypted credential is expected to expose a
    // top-level `secret` string field. Any failure here is converted to a
    // verification-refused state by the caller; nothing in this layer logs the
    // secret or the credential.
    const [connection] = await this.scope.db
      .select({
        id: connections.id,
        status: connections.status,
        encryptedCredentials: connections.encryptedCredentials,
      })
      .from(connections)
      .where(
        and(
          this.scope.where(connections.tenantId),
          eq(connections.id, config.secret_connection_id),
        ),
      )
      .limit(1);

    if (connection === undefined) {
      throw new WebhookSignatureSecretUnavailableError(
        'connection_not_found',
        'the configured signing connection does not exist in this tenant',
      );
    }
    if (connection.status !== 'active') {
      throw new WebhookSignatureSecretUnavailableError(
        'connection_disabled',
        'the configured signing connection is not active',
      );
    }

    const decrypted = this.cipher.decrypt(
      connection.encryptedCredentials as EncryptedEnvelope,
      { tenantId: this.scope.tenantId, connectionId: connection.id },
    );
    const secretValue = decrypted.secret;
    if (typeof secretValue !== 'string' || secretValue.length === 0) {
      throw new WebhookSignatureSecretUnavailableError(
        'connection_credential_malformed',
        'the configured signing connection has no string "secret" field in its credential',
      );
    }

    return { config, secret: secretValue };
  }
}

/**
 * The resolver throws this when the secret-bearing connection cannot be used.
 * The route layer catches it, logs the code, and returns a generic 401 — the
 * stored code is for operators only.
 */
export class WebhookSignatureSecretUnavailableError extends Error {
  readonly code:
    | 'connection_not_found'
    | 'connection_disabled'
    | 'connection_credential_malformed';
  constructor(
    code:
      | 'connection_not_found'
      | 'connection_disabled'
      | 'connection_credential_malformed',
    message: string,
  ) {
    super(message);
    this.name = 'WebhookSignatureSecretUnavailableError';
    this.code = code;
  }
}

/**
 * Build a tenant-scoped resolver for an authenticated webhook request. Wired at
 * composition time (server.ts / tests) and called per request.
 */
export type WebhookSignatureResolverFactory = (auth: AuthContext) => WebhookSignatureResolver;
