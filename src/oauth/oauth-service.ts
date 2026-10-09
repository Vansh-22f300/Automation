/**
 * The OAuth orchestrator (state design §12): the thin use-case layer that binds
 * the pure primitives, the fail-closed registry, the state store, and the token
 * client into the two flows a caller drives — begin authorization, and complete
 * the callback — plus disconnect. It holds NO persistence of its own and is not an
 * auth service; each collaborator keeps its single responsibility.
 *
 * THE TRUST BOUNDARY (state design §5/§6/§8/§14). `beginAuthorization` runs in an
 * authenticated context, so tenant/user are trusted inputs and are sealed into the
 * state row. `completeCallback` is UNAUTHENTICATED: the only things it trusts from
 * the request are the opaque `state` (looked up by hash) and the `code`. Tenant,
 * user, provider, return path, and the PKCE verifier are all RECOVERED from the
 * consumed row — never read from the callback query — which is what defeats the
 * confused-deputy/CSRF attack. The route's `:provider` is used solely as a match
 * predicate inside the atomic consume (state design §9).
 *
 * THE REDIRECT URI (state design §7) is always `${appOrigin}/oauth/{provider}/
 * callback`, built from the server-configured origin — never from a Host or
 * X-Forwarded-* header — so it matches the exact value registered with the provider.
 */

import { OAuthStateInvalidError } from '@/oauth/errors.js';
import { deriveCodeChallenge, generateCodeVerifier } from '@/oauth/pkce.js';
import { buildAuthorizationUrl, type OAuthProviderRegistry } from '@/oauth/provider-config.js';
import { resolveReturnPath } from '@/oauth/return-path.js';
import { generateOAuthState, hashOAuthState } from '@/oauth/state-token.js';
import type { OAuthTokenClient, OAuthTokenSet } from '@/oauth/token-client.js';
import { serializeTokenSet, type TokenRevoker } from '@/oauth/token-source.js';
import type { ConnectionRepository } from '@/repositories/connection-repository.js';
import type { OAuthStateStore } from '@/repositories/oauth-state-repository.js';

/** Short-lived by design (state design §5): an authorize round-trip is minutes. */
export const DEFAULT_STATE_TTL_MS = 10 * 60_000;

/** Authenticated inputs to start a flow. tenant/user come from the session, never the body. */
export interface BeginAuthorizationInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly provider: string;
  /** Untrusted; validated to a safe internal path or defaulted. */
  readonly returnPath?: string;
  /** Overrides the provider's default scopes when present. */
  readonly scopes?: readonly string[];
}

/** What the callback observes. `provider` is the route segment; the rest is query. */
export interface CompleteCallbackInput {
  readonly provider: string;
  readonly state: string;
  readonly code: string;
}

/** The safe result of a completed callback: where to send the browser, and what was created. */
export interface CompleteCallbackResult {
  readonly returnPath: string;
  readonly connectionId: string;
}

export interface DisconnectInput {
  readonly tenantId: string;
  readonly connectionId: string;
}

/**
 * What a provider-specific finalizer decides about the connection to persist: the
 * `name` it should carry (e.g. the GitHub login, so re-authorizing the same account
 * heals one row via the `(tenant, provider, name)` upsert instead of piling up
 * duplicates) and optional non-secret `metadata` (identity descriptors, scopes).
 */
export interface ConnectionFinalization {
  readonly name: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * An optional, per-provider post-exchange hook. Runs on the API server inside
 * {@link OAuthService.completeCallback} with the freshly-exchanged token set, and
 * may call the provider's identity endpoint to derive the connection name/metadata.
 * It MUST NOT return (or log) any secret — only non-secret descriptors. A thrown
 * {@link OAuthProviderError}/{@link OAuthProviderUnavailableError} surfaces through the
 * callback route's error mapping; the connection is not persisted.
 */
export interface ConnectionFinalizer {
  finalize(input: { readonly tokenSet: OAuthTokenSet }): Promise<ConnectionFinalization>;
}

export interface OAuthServiceDeps {
  readonly registry: OAuthProviderRegistry;
  readonly stateStore: OAuthStateStore;
  readonly tokenClient: OAuthTokenClient;
  readonly revoker: TokenRevoker;
  /** Builds a tenant-scoped connection repository for the recovered tenant. */
  readonly connectionRepositoryFor: (tenantId: string) => ConnectionRepository;
  /**
   * Optional per-provider finalizers, keyed by provider slug. A provider without an
   * entry persists a connection named after the provider itself (the prior default).
   */
  readonly connectionFinalizers?: ReadonlyMap<string, ConnectionFinalizer>;
  /** The trusted origin for the exact redirect URI (e.g. `env.APP_ORIGIN`). */
  readonly appOrigin: string;
  readonly stateTtlMs?: number;
  readonly now?: () => number;
}

/**
 * Constructed once at composition root and shared. Stateless beyond its injected
 * collaborators; every per-request tenant scope is built on demand via
 * {@link OAuthServiceDeps.connectionRepositoryFor}.
 */
export class OAuthService {
  private readonly stateTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: OAuthServiceDeps) {
    this.stateTtlMs = deps.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Mint a state + PKCE pair, persist the sealed row bound to the caller, and
   * return the provider authorization URL. The raw `state` travels only in the
   * URL; only its hash is stored. Fails closed if the provider is not registered
   * (registry) or the return path is unsafe (`resolveReturnPath`).
   */
  async beginAuthorization(input: BeginAuthorizationInput): Promise<{ authorizationUrl: string }> {
    const config = this.deps.registry.get(input.provider);
    const returnPath = resolveReturnPath(input.returnPath);

    const state = generateOAuthState();
    const stateHash = hashOAuthState(state);
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = deriveCodeChallenge(codeVerifier);
    const redirectUri = this.redirectUri(config.provider);

    await this.deps.stateStore.create({
      tenantId: input.tenantId,
      userId: input.userId,
      provider: config.provider,
      returnPath,
      stateHash,
      codeVerifier,
      expiresAt: new Date(this.now() + this.stateTtlMs),
    });

    const authorizationUrl = buildAuthorizationUrl({
      config,
      redirectUri,
      state,
      codeChallenge,
      ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
    });
    return { authorizationUrl };
  }

  /**
   * Atomically consume the state (single-use, unexpired, provider-matched),
   * recover the trusted context from the row, exchange the code for tokens, and
   * persist them as a tenant-scoped connection. An unresolved state throws
   * {@link OAuthStateInvalidError}; nothing from the query is trusted.
   */
  async completeCallback(input: CompleteCallbackInput): Promise<CompleteCallbackResult> {
    const stateHash = hashOAuthState(input.state);
    const consumed = await this.deps.stateStore.consume({ stateHash, provider: input.provider });
    if (consumed === null) {
      throw new OAuthStateInvalidError();
    }

    // From here everything is server-recovered and trusted.
    const config = this.deps.registry.get(consumed.provider);
    const tokenSet = await this.deps.tokenClient.exchangeCode({
      config,
      code: input.code,
      redirectUri: this.redirectUri(consumed.provider),
      codeVerifier: consumed.codeVerifier,
    });

    // An optional provider finalizer may validate the granted identity and choose
    // the connection name/metadata; without one, the connection is named for the
    // provider (the prior default). It runs after a successful exchange, so a thrown
    // provider error here means "token obtained but identity rejected" and the
    // connection is not persisted.
    const finalizer = this.deps.connectionFinalizers?.get(consumed.provider);
    const finalized: ConnectionFinalization =
      finalizer !== undefined ? await finalizer.finalize({ tokenSet }) : { name: consumed.provider };

    const repository = this.deps.connectionRepositoryFor(consumed.tenantId);
    // Upsert on (tenant, provider, name): re-authorizing the same account heals the
    // existing row (re-credential + re-activate) rather than accumulating duplicates.
    const connection = await repository.upsertByProviderName({
      provider: consumed.provider,
      name: finalized.name,
      credential: { ...serializeTokenSet(tokenSet) },
      ...(finalized.metadata !== undefined ? { metadata: finalized.metadata } : {}),
    });

    return { returnPath: consumed.returnPath, connectionId: connection.id };
  }

  /**
   * Disconnect a connection: best-effort provider-neutral revoke (a no-op until a
   * provider wires one), then disable the local row. Tenant-scoped; returns false
   * if no such connection exists in the tenant.
   */
  async disconnect(input: DisconnectInput): Promise<boolean> {
    const repository = this.deps.connectionRepositoryFor(input.tenantId);
    const metadata = await repository.getMetadata(input.connectionId);
    if (metadata === null) return false;

    await this.deps.revoker.revoke({
      provider: metadata.provider,
      tenantId: input.tenantId,
      connectionId: input.connectionId,
    });
    await repository.disable(input.connectionId);
    return true;
  }

  /** The exact registered redirect URI, built from the trusted origin only. */
  private redirectUri(provider: string): string {
    return new URL(`/oauth/${provider}/callback`, this.deps.appOrigin).toString();
  }
}
