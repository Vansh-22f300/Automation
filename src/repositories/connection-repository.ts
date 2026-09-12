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

import { and, desc, eq, lt, or, sql } from "drizzle-orm";

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

/**
 * A connection row that is "rotatable": its stored envelope's `kid` is not the
 * current active kid (or it has no `kid`, i.e. it is a v1 envelope). The
 * encrypted envelope is included so a dry-run can validate the same key
 * resolution and AAD a real rotation would perform, without re-fetching.
 */
export interface RotatableConnection {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly status: ConnectionStatus;
  readonly metadata: Record<string, unknown>;
  readonly encryptedCredentials: EncryptedEnvelope;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastUsedAt: Date | null;
}

export interface RotatableListPage {
  readonly items: readonly RotatableConnection[];
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
      { tenantId: this.tenantId, connectionId: row.id },
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

  /**
   * Page through this tenant's connections whose envelope `kid` is not the
   * current active kid. v1 envelopes (no `kid` field) match because the
   * jsonb `->>` extraction returns NULL, which is DISTINCT FROM any string.
   * Already-rotated rows (kid = activeKid) are excluded at the SQL layer;
   * re-running rotation on the same tenant is a no-op.
   *
   * The query is a plain SELECT (no FOR UPDATE). A dry-run that calls this
   * method does not contend with a concurrent real rotation; a real
   * rotation re-checks the predicate under the row lock inside
   * {@link rotateCredentials}.
   *
   * Ordering and keyset pagination reuse {@link listMetadataPage}'s contract
   * verbatim: `(created_at DESC, id DESC)` with a base64url-encoded cursor.
   */
  async listRotatable(
    activeKid: string,
    options: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<RotatableListPage> {
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

    const kidMismatch = sql`(${connections.encryptedCredentials} ->> 'kid') IS DISTINCT FROM ${activeKid}`;
    const whereClause =
      cursorClause === undefined
        ? this.scope.where(connections.tenantId, kidMismatch)
        : this.scope.where(connections.tenantId, cursorClause, kidMismatch);

    const rows = await this.db
      .select()
      .from(connections)
      .where(whereClause)
      .orderBy(desc(connections.createdAt), desc(connections.id))
      .limit(pageLimit + 1);

    const items = rows.slice(0, pageLimit).map((row) => ({
      id: row.id,
      provider: row.provider,
      name: row.name,
      status: row.status as ConnectionStatus,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      encryptedCredentials: row.encryptedCredentials as EncryptedEnvelope,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastUsedAt: row.lastUsedAt,
    }));
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

  /**
   * Per-row rotation transaction. Locks the row, re-checks the rotatable
   * predicate under the lock (compare-and-set: a concurrent rotation that
   * just committed on this row will see kid = activeKid and return null),
   * decrypts the existing envelope, re-encrypts under the active kid with
   * the row's AAD binding, and bumps `updated_at` to `now()`.
   *
   * Returns:
   *   - the row's metadata, with the new envelope, when the row was rotated;
   *   - `null` when the row is not in this tenant, has been deleted, or is
   *     already on the active kid at the moment the row lock is acquired.
   *
   * The transaction is intentionally short and scoped to one row. It does
   * NOT touch `last_used_at` — only `encrypted_credentials` and `updated_at`.
   * Concurrent reads (e.g. `resolveForTool`) take MVCC snapshots at SELECT
   * start and never block on rotation's row lock; concurrent `UPDATE` paths
   * (`updateMetadata`, `disable`, `delete`) serialize with rotation by row
   * lock acquisition order, applying to the rotated row atomically.
   */
  async rotateCredentials(
    id: string,
    activeKid: string,
  ): Promise<ConnectionMetadata | null> {
    return this.db.transaction(async (tx) => {
      const kidMismatch = sql`(${connections.encryptedCredentials} ->> 'kid') IS DISTINCT FROM ${activeKid}`;
      const [row] = await tx
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.tenantId, this.tenantId),
            eq(connections.id, id),
            kidMismatch,
          ),
        )
        .for('update');
      if (!row) return null;

      const envelope = row.encryptedCredentials as EncryptedEnvelope;
      const aad = Buffer.from(`${this.tenantId}:${row.id}`, 'utf8');
      const plaintext = this.cipher.decrypt(envelope, {
        tenantId: this.tenantId,
        connectionId: row.id,
        aad,
      });

      const newEnvelope = this.cipher.encryptWithActive(plaintext, aad);
      const [updated] = await tx
        .update(connections)
        .set({ encryptedCredentials: newEnvelope, updatedAt: new Date() })
        .where(
          and(
            eq(connections.tenantId, this.tenantId),
            eq(connections.id, id),
          ),
        )
        .returning();
      return updated ? ConnectionRepository.toMetadata(updated) : null;
    });
  }
}
