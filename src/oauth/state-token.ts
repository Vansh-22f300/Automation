/**
 * The opaque OAuth `state` value and its at-rest hash.
 *
 * `state` does double duty: it is the CSRF token that ties a callback back to the
 * authorize request this server started, and it is the lookup key into
 * `oauth_states`. It follows the same hash-at-rest discipline as session tokens
 * (`@/auth/session-token`) and email tokens: the raw value travels in the
 * authorize URL and comes back in the callback query, but only its SHA-256 digest
 * is ever persisted, so a database dump cannot reconstruct a working callback URL.
 *
 * Pure functions over `node:crypto`; no I/O, no logging.
 */

import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes → 256 bits of entropy, base64url-encoded (43 chars). */
const STATE_BYTES = 32;

/** Mint a fresh, unguessable state value to carry through the authorize round-trip. */
export function generateOAuthState(): string {
  return randomBytes(STATE_BYTES).toString('base64url');
}

/**
 * The at-rest form of a state value: lowercase-hex SHA-256. Deterministic, so a
 * callback can look the row up by hashing the state it was handed; one-way, so the
 * stored hash never yields the value.
 */
export function hashOAuthState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}
