/**
 * Tenant-scoped persistence for external-service connections, and the one narrow
 * path that decrypts a credential for use.
 *
 * Everything here goes through `scope.where(...)`, so no query can escape its
 * tenant. The repository exposes two clearly separated capabilities:
 *
 *   - **Metadata operations** (`create`, `listMetadata`, `getMetadata`,
 *     `updateMetadata`, `disable`, `delete`) — they read and write the row's
 *     non-secret facts. `listMetadata`/`getMetadata` NEVER return the credential;
 *     they return {@link ConnectionMetadata}, which has no field for it.
 *   - **The decrypt path** (`resolveForTool`, implementing {@link ConnectionResolver})
 *     — the only method that decrypts. It resolves within the tenant, checks the
 *     connection is active, decrypts, and touches `last_used_at`. It exists so the
 *     tool executor can turn a trusted {@link ConnectionRef} into an
 *     {@link AuthorizedConnection} at the execution boundary — and nowhere else does
 *     a credential become plaintext.
 *
 * The cipher is injected so the repository can be constructed for metadata-only work
 * without a key (the key is only demanded when an encrypt/decrypt actually runs).
 */

import { and, desc, eq, lt, or } from "drizzle-orm";

import { BadRequestError } from "@/api/errors.js";
import { connections } from "@/db/schema.js";
import type { Connection } from "@/db/schema.js";
import type {
  AuthorizedConnection,
  ConnectionMetadata,
  ConnectionRef,
  ConnectionResolver,
  ConnectionStatus,
} from "@/domain/connection.js";
import {
  DisabledConnectionError,
  MissingConnectionError,
} from "@/domain/tool-errors.js";
import {
  TenantScope,
  TenantScopedRepository,
} from "@/repositories/tenant-scope.js";
import type {
  CredentialCipher,
  EncryptedEnvelope,
} from "@/security/credential-cipher.js";

export interface ConnectionListPage {
  readonly items: readonly ConnectionMetadata[];
  readonly nextCursor: string | null;
}

export interface ConnectionListReader {
  listMetadata(limit?: number): Promise<ConnectionMetadata[]>;
  listMetadataPage(options?: {
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<ConnectionListPage>;
}

/** What creating a connection needs: the identity plus the secret to encrypt. */
export interface CreateConnectionInput {
  readonly provider: string;
  readonly name: string;
  /** The credential object to encrypt at rest. Never persisted in the clear. */
  readonly credential: Record<string, unknown>;
  /** Optional non-secret descriptors. Never put the secret here. */
  readonly metadata?: Record<string, unknown>;
}

export class ConnectionRepository
  extends TenantScopedRepository
  implements ConnectionResolver, ConnectionListReader
{
  constructor(
    scope: TenantScope,
    private readonly cipher: CredentialCipher,
  ) {
    super(scope);
  }

  /** Project a row to its non-secret metadata. The credential envelope is dropped. */
  private static toMetadata(row: Connection): ConnectionMetadata {
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      status: row.status as ConnectionStatus,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastUsedAt: row.lastUsedAt,
    };
  }

  /** Create a connection, encrypting the credential before it ever reaches the DB. */
  async create(input: CreateConnectionInput): Promise<ConnectionMetadata> {
    const envelope = this.cipher.encrypt(input.credential);
    const [row] = await this.db
      .insert(connections)
      .values({
        tenantId: this.tenantId,
        provider: input.provider,
        name: input.name,
        encryptedCredentials: envelope,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      })
      .returning();
    return ConnectionRepository.toMetadata(row!);
  }

  /** All connections for this tenant, newest first — metadata only, never secrets. */
  async listMetadata(limit = 100): Promise<ConnectionMetadata[]> {
    const rows = await this.listMetadataPage({ limit });
    return [...rows.items];
  }

  private static encodeCursor(cursor: {
    readonly createdAt: string;
    readonly id: string;
  }): string {
    return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  }

  private static decodeCursor(cursor: string): {
    createdAt: string;
    id: string;
  } {
    try {
      const parsed = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      ) as {
        createdAt?: unknown;
        id?: unknown;
      };
      if (
        typeof parsed.createdAt !== "string" ||
        typeof parsed.id !== "string"
      ) {
        throw new Error("invalid cursor");
      }
      if (Number.isNaN(new Date(parsed.createdAt).getTime())) {
        throw new Error("invalid cursor");
      }
      return { createdAt: parsed.createdAt, id: parsed.id };
    } catch {
      throw new BadRequestError("Cursor is invalid");
    }
  }

  async listMetadataPage(
    options: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<ConnectionListPage> {
    const pageLimit = Math.max(1, Math.min(options.limit ?? 100, 100));
    const parsedCursor =
      options.cursor === undefined
        ? null
        : ConnectionRepository.decodeCursor(options.cursor);
    const cursorDate =
      parsedCursor === null ? null : new Date(parsedCursor.createdAt);
    const cursorId = parsedCursor?.id;
    const cursorClause =
      cursorDate === null || cursorId === undefined
        ? undefined
        : or(
            lt(connections.createdAt, cursorDate),
            and(
              eq(connections.createdAt, cursorDate),
              lt(connections.id, cursorId),
            ),
          );

    const rows = await this.db
      .select()
      .from(connections)
      .where(
        cursorClause === undefined
          ? this.scope.where(connections.tenantId)
          : this.scope.where(connections.tenantId, cursorClause),
      )
      .orderBy(desc(connections.createdAt), desc(connections.id))
      .limit(pageLimit + 1);

    const items = rows.slice(0, pageLimit).map(ConnectionRepository.toMetadata);
    const lastRow = rows[pageLimit - 1];
    const nextCursor =
      rows.length > pageLimit && lastRow !== undefined
        ? ConnectionRepository.encodeCursor({
            createdAt: lastRow.createdAt.toISOString(),
            id: lastRow.id,
          })
        : null;
    return { items, nextCursor };
  }

  /** One connection's metadata by id, or null if not in this tenant. Never the secret. */
  async getMetadata(id: string): Promise<ConnectionMetadata | null> {
    const [row] = await this.db
      .select()
      .from(connections)
      .where(this.scope.where(connections.tenantId, eq(connections.id, id)));
    return row ? ConnectionRepository.toMetadata(row) : null;
  }

  /** Replace a connection's non-secret metadata. Returns null if not in this tenant. */
  async updateMetadata(
    id: string,
    metadata: Record<string, unknown>,
  ): Promise<ConnectionMetadata | null> {
    const [row] = await this.db
      .update(connections)
      .set({ metadata, updatedAt: new Date() })
      .where(this.scope.where(connections.tenantId, eq(connections.id, id)))
      .returning();
    return row ? ConnectionRepository.toMetadata(row) : null;
  }

  /** Mark a connection disabled. Idempotent. Returns null if not in this tenant. */
  async disable(id: string): Promise<ConnectionMetadata | null> {
    const [row] = await this.db
      .update(connections)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(this.scope.where(connections.tenantId, eq(connections.id, id)))
      .returning();
    return row ? ConnectionRepository.toMetadata(row) : null;
  }

  /** Delete a connection. Returns true if a row in this tenant was removed. */
  async delete(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(connections)
      .where(this.scope.where(connections.tenantId, eq(connections.id, id)))
      .returning({ id: connections.id });
    return rows.length > 0;
  }

  /**
   * The one decrypt path. Resolve a connection for a tool run and return it with its
   * credential decrypted. Tenant-scoped by construction; a cross-tenant id resolves
   * to nothing (→ {@link MissingConnectionError}). A non-active connection is refused
   * (→ {@link DisabledConnectionError}). On success, `last_used_at` is touched.
   */
  async resolveForTool(ref: ConnectionRef): Promise<AuthorizedConnection> {
    // Resolve either by explicit id (trusted config only) or the active connection
    // for the provider. Both are anchored to this tenant.
    const [row] =
      ref.connectionId !== undefined
        ? await this.db
            .select()
            .from(connections)
            .where(
              this.scope.where(
                connections.tenantId,
                eq(connections.id, ref.connectionId),
              ),
            )
        : await this.db
            .select()
            .from(connections)
            .where(
              this.scope.where(
                connections.tenantId,
                eq(connections.provider, ref.provider),
                eq(connections.status, "active"),
              ),
            );

    if (!row) {
      throw new MissingConnectionError(ref);
    }
    // An explicit id might point at a connection of a different provider or a
    // non-active one; enforce both here.
    if (row.provider !== ref.provider) {
      throw new MissingConnectionError(ref);
    }
    if (row.status !== "active") {
      throw new DisabledConnectionError(row.id, row.status);
    }

    const credential = this.cipher.decrypt(
      row.encryptedCredentials as EncryptedEnvelope,
    );

    // Best-effort hygiene: record that the credential was used. Scoped to tenant.
    await this.db
      .update(connections)
      .set({ lastUsedAt: new Date() })
      .where(
        this.scope.where(connections.tenantId, eq(connections.id, row.id)),
      );

    return {
      metadata: {
        ...ConnectionRepository.toMetadata(row),
        lastUsedAt: new Date(),
      },
      credential,
    };
  }
}
