/**
 * Persistence for `oauth_states` — the server-side record that carries the
 * trusted initiating context across the OAuth round-trip, and the single-use gate
 * the callback passes through.
 *
 * WHY A STORE, NOT AN AUTH SERVICE (state design §12). This owns exactly three
 * responsibilities: seal-and-insert a new state, atomically consume one, and
 * clean up dead rows. It does not build URLs, talk to providers, or decide policy
 * — {@link OAuthService} does that. It is deliberately NOT tenant-scoped: the
 * callback that consumes a row is unauthenticated (it cannot present a tenant),
 * so lookup is by the globally-unique `state_hash`, and the trusted tenant/user
 * are RECOVERED from the row (state design §6/§8), never taken from the request.
 *
 * THE VERIFIER AT REST (state design §3). The plaintext PKCE verifier never
 * leaves this module unsealed: `create` seals it with {@link OAuthStateSecretBox}
 * under AAD = `state_hash`, and `consume` opens it under the same AAD. Binding the
 * AAD to the row's own hash means a sealed verifier copied onto another row cannot
 * be opened — the tag verification fails.
 *
 * SINGLE USE (state design §4). {@link DrizzleOAuthStateStore.consume} mirrors the
 * auth-token consume: one conditional `UPDATE … WHERE consumed_at IS NULL AND
 * expires_at > now() RETURNING`, so two racing callbacks cannot both win and a
 * replay matches no row. `now()` is Postgres' clock, so expiry is server-judged.
 */

import { and, eq, inArray, isNull, isNotNull, or, sql } from 'drizzle-orm';

import type { AppDatabase } from '@/db/client.js';
import { oauthStates } from '@/db/schema.js';
import {
  OAuthStateSecretBox,
  type OAuthSecretEnvelope,
} from '@/oauth/state-secret-box.js';

/** Fields to persist a new state row. All are server-derived at authorize time. */
export interface CreateOAuthStateInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly provider: string;
  readonly returnPath: string;
  /** SHA-256 hash of the opaque state; the raw state is never stored. */
  readonly stateHash: string;
  /** Plaintext PKCE verifier; sealed before it touches the row. */
  readonly codeVerifier: string;
  readonly expiresAt: Date;
}

/** Identifies the state to spend: its hash AND the provider the route claims. */
export interface ConsumeOAuthStateInput {
  readonly stateHash: string;
  /** The `:provider` from the callback route; must equal the stored provider. */
  readonly provider: string;
}

/** The trusted context recovered from a successfully consumed row. */
export interface ConsumedOAuthState {
  readonly tenantId: string;
  readonly userId: string;
  readonly provider: string;
  readonly returnPath: string;
  /** The decrypted PKCE verifier, for the token exchange. */
  readonly codeVerifier: string;
}

export interface CleanupOptions {
  /** Max rows to remove in one call; bounds the delete. */
  readonly limit?: number;
}

/** Default cleanup batch — large enough to keep up, small enough to stay bounded. */
export const DEFAULT_CLEANUP_BATCH = 5_000;

/** The storage-agnostic seam {@link OAuthService} depends on. */
export interface OAuthStateStore {
  create(input: CreateOAuthStateInput): Promise<void>;
  consume(input: ConsumeOAuthStateInput): Promise<ConsumedOAuthState | null>;
  /** Remove consumed OR expired rows only; never a live unexpired state. Returns the count. */
  deleteExpiredAndConsumed(options?: CleanupOptions): Promise<number>;
}

/**
 * Postgres-backed store. Holds the {@link OAuthStateSecretBox} so the AAD used to
 * seal a verifier is always exactly the row's `state_hash` — a caller can never
 * pass a mismatched AAD.
 */
export class DrizzleOAuthStateStore implements OAuthStateStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly secretBox: OAuthStateSecretBox,
  ) {}

  async create(input: CreateOAuthStateInput): Promise<void> {
    const envelope = this.secretBox.seal(input.codeVerifier, input.stateHash);
    await this.db.insert(oauthStates).values({
      tenantId: input.tenantId,
      userId: input.userId,
      provider: input.provider,
      returnPath: input.returnPath,
      stateHash: input.stateHash,
      encryptedCodeVerifier: envelope,
      expiresAt: input.expiresAt,
    });
  }

  async consume(input: ConsumeOAuthStateInput): Promise<ConsumedOAuthState | null> {
    // Single-use is this one statement. The WHERE is the guard (right hash, right
    // provider, not yet consumed, not expired); RETURNING makes the winning update
    // also the read of the trusted context. Two racing callbacks cannot both match
    // `consumed_at IS NULL` on the same row — one commits `consumed_at = now()`,
    // the other updates nothing and gets an empty set. A wrong-provider or replayed
    // callback likewise matches no row (and does NOT burn a still-valid state).
    const rows = await this.db
      .update(oauthStates)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(oauthStates.stateHash, input.stateHash),
          eq(oauthStates.provider, input.provider),
          isNull(oauthStates.consumedAt),
          sql`${oauthStates.expiresAt} > now()`,
        ),
      )
      .returning({
        tenantId: oauthStates.tenantId,
        userId: oauthStates.userId,
        provider: oauthStates.provider,
        returnPath: oauthStates.returnPath,
        stateHash: oauthStates.stateHash,
        encryptedCodeVerifier: oauthStates.encryptedCodeVerifier,
      });

    const row = rows[0];
    if (row === undefined) return null;

    // Open under AAD = the row's own hash. A tampered/relocated envelope fails here.
    const codeVerifier = this.secretBox.open(
      row.encryptedCodeVerifier as OAuthSecretEnvelope,
      row.stateHash,
    );
    return {
      tenantId: row.tenantId,
      userId: row.userId,
      provider: row.provider,
      returnPath: row.returnPath,
      codeVerifier,
    };
  }

  async deleteExpiredAndConsumed(options: CleanupOptions = {}): Promise<number> {
    const limit = options.limit ?? DEFAULT_CLEANUP_BATCH;
    // Bounded by a LIMITed subselect so a backlog is drained in batches rather than
    // one unbounded delete. The predicate targets ONLY dead rows — consumed, or
    // past expiry by Postgres' clock — so a live unexpired state is never removed.
    const doomed = this.db
      .select({ id: oauthStates.id })
      .from(oauthStates)
      .where(or(isNotNull(oauthStates.consumedAt), sql`${oauthStates.expiresAt} <= now()`))
      .limit(limit);
    const deleted = await this.db
      .delete(oauthStates)
      .where(inArray(oauthStates.id, doomed))
      .returning({ id: oauthStates.id });
    return deleted.length;
  }
}
