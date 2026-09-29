/**
 * Safe classification of OAuth provider failures (state design §12).
 *
 * A token endpoint is an *external* dependency we do not control, and its raw
 * response body may contain provider-internal detail, reflected request data, or
 * even fragments of the very credentials we are exchanging. So the token client
 * never throws the body: it parses out at most the short, spec-defined `error`
 * token (RFC 6749 §5.2 — e.g. `invalid_grant`) and hands it here to be turned
 * into one of exactly two shapes, with a fixed human message:
 *
 *   - {@link OAuthProviderUnavailableError} — transient (5xx, 429, network,
 *     timeout). Extends {@link RetryableError}; a later retry could succeed.
 *   - {@link OAuthProviderError} — deterministic (a 4xx `invalid_grant`,
 *     `invalid_client`, a malformed token response). Extends
 *     {@link PermanentError}; retrying the same exchange cannot help.
 *
 * A third shape, {@link OAuthStateInvalidError}, covers the state-lookup gate:
 * not found / expired / already consumed / provider-mismatch are ALL reported
 * with one undifferentiated error, so a caller (or an attacker probing the
 * callback) cannot tell which condition it hit — the same reasoning as the
 * uniform `null` from the auth-token consume.
 *
 * No function here accepts or stores a raw response body. The only provider text
 * that survives is an `error` token validated against a strict charset.
 */

import { PermanentError, RetryableError } from '@/domain/errors.js';

/**
 * Constrain a provider-supplied `error` token to the RFC 6749 charset before it
 * is allowed anywhere near a log line or an error `details` bag. Anything longer,
 * empty, or containing unexpected characters collapses to `'unrecognized'` —
 * this is the guard that stops a hostile or buggy provider smuggling arbitrary
 * text (or a credential fragment) out through our error path.
 */
export function safeOAuthErrorCode(raw: unknown): string {
  return typeof raw === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(raw) ? raw : 'unrecognized';
}

/** Deterministic OAuth failure: the exchange itself was rejected or malformed. */
export class OAuthProviderError extends PermanentError {
  constructor(message: string, reason: string, cause?: unknown) {
    super('oauth_provider_error', message, { details: { reason }, cause });
  }
}

/** Transient OAuth failure: the provider was unreachable or asked us to back off. */
export class OAuthProviderUnavailableError extends RetryableError {
  constructor(message: string, reason: string, cause?: unknown) {
    super('oauth_provider_unavailable', message, { details: { reason }, cause });
  }
}

/**
 * The OAuth `state` presented at the callback did not resolve to a live,
 * unconsumed, matching row. Intentionally undifferentiated across not-found /
 * expired / already-consumed / wrong-provider so the failure cannot be probed.
 */
export class OAuthStateInvalidError extends PermanentError {
  constructor() {
    super('oauth_state_invalid', 'the OAuth state is missing, expired, already used, or mismatched');
  }
}

/** What the token client observed at the token endpoint, pre-classification. */
export interface TokenEndpointFailure {
  /** HTTP status, or `undefined` for a network/timeout failure with no response. */
  readonly status?: number | undefined;
  /** The provider's short `error` token if one was parsed; never the raw body. */
  readonly errorCode?: string | undefined;
  /** Underlying error (e.g. an abort), preserved for stack chaining only. */
  readonly cause?: unknown;
}

/**
 * Map a token-endpoint failure onto the retryable/permanent split. A missing
 * status (network/timeout), a 5xx, or a 429 is transient; every other status —
 * chiefly a 4xx `invalid_grant`/`invalid_client` — is deterministic. The
 * provider `error` token is sanitised before it is carried in `details`.
 */
export function classifyTokenEndpointError(
  failure: TokenEndpointFailure,
): OAuthProviderError | OAuthProviderUnavailableError {
  const reason = safeOAuthErrorCode(failure.errorCode);
  const { status } = failure;
  const transient = status === undefined || status === 429 || status >= 500;
  if (transient) {
    return new OAuthProviderUnavailableError(
      'the OAuth provider is temporarily unavailable',
      reason,
      failure.cause,
    );
  }
  return new OAuthProviderError('the OAuth provider rejected the token request', reason, failure.cause);
}
