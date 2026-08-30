/**
 * Connections: the domain view of a stored external-service credential.
 *
 * A "connection" is a tenant's authorization to act against some external provider
 * (Slack, GitHub, Gmail — none of which exist yet). It has two halves that this
 * module keeps deliberately separate:
 *
 *   - {@link ConnectionMetadata} — the row's identifying, non-secret facts (id,
 *     provider, name, status, timestamps). Safe to list, log by id, and return from
 *     an API. It NEVER contains the credential.
 *   - the decrypted credential — the actual secret. It exists only transiently, only
 *     on the narrow authorize-then-decrypt path, and only inside an
 *     {@link AuthorizedConnection} handed to a connector at the moment of execution.
 *
 * The {@link ConnectionResolver} seam is what the tool executor depends on. It is
 * tenant-scoped by construction (a resolver belongs to one tenant), so there is no
 * parameter by which a caller — or a model — could name another tenant. Resolution
 * is by *provider* (the tenant's single active connection for it) or by an explicit
 * *connectionId* that originates from trusted platform/workflow config, never from
 * the model's tool arguments.
 *
 * This module is pure: no SDK, no database, no framework. Repositories implement the
 * resolver; the executor and connectors depend only on these types.
 */

import type { CredentialPayload } from '@/security/credential-cipher.js';

/**
 * The lifecycle state of a connection.
 * - `active`   — usable; the one state `resolveForTool` will decrypt.
 * - `disabled` — deliberately turned off; resolution refuses it.
 * - `error`    — marked broken (e.g. credential rejected upstream); resolution refuses it.
 */
export type ConnectionStatus = 'active' | 'disabled' | 'error';

export const CONNECTION_STATUSES: readonly ConnectionStatus[] = ['active', 'disabled', 'error'];

/**
 * The non-secret facts about a connection. This is what listing and inspection
 * return. It deliberately has no field that could hold the credential.
 */
export interface ConnectionMetadata {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly status: ConnectionStatus;
  /** Free-form non-secret descriptors (e.g. account label, scopes) — never the secret. */
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** When a credential was last decrypted for use, or null if never. */
  readonly lastUsedAt: Date | null;
}

/**
 * A resolved, authorized connection: metadata plus the decrypted credential. Produced
 * only by {@link ConnectionResolver.resolveForTool} at the execution boundary and
 * held for the minimal time needed to run a connector. Never persisted, never logged,
 * never returned from an API.
 */
export interface AuthorizedConnection {
  readonly metadata: ConnectionMetadata;
  readonly credential: CredentialPayload;
}

/** How a tool run names the connection to use. */
export interface ConnectionRef {
  /** The provider whose active connection to resolve (e.g. 'slack'). */
  readonly provider: string;
  /**
   * An explicit connection id. Overrides provider-based resolution. MUST originate
   * from trusted platform/workflow config — never from the model's tool arguments —
   * so the model cannot select an arbitrary connection.
   */
  readonly connectionId?: string;
}

/**
 * The seam the tool executor depends on to turn a {@link ConnectionRef} into an
 * {@link AuthorizedConnection}. Implemented by the tenant-scoped connection
 * repository, which is why there is no tenant parameter here: a resolver is bound to
 * exactly one tenant, so cross-tenant resolution is not expressible.
 *
 * Implementations must:
 *   - scope every lookup to their tenant (a connectionId for another tenant simply
 *     does not resolve → treated as missing);
 *   - refuse a connection whose status is not `active`;
 *   - decrypt only here, only after those checks pass.
 */
export interface ConnectionResolver {
  resolveForTool(ref: ConnectionRef): Promise<AuthorizedConnection>;
}
