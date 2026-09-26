/**
 * Session-token primitives — generation and hashing, and nothing else.
 *
 * A session token is an *opaque bearer secret*: a long random string that means
 * nothing on its own and encodes no tenant, user, expiry, or any other claim.
 * All of those live in the `sessions` row the token's hash points at. That is
 * deliberate — an opaque token cannot be tampered into naming a different tenant
 * or user, and it leaks nothing if it appears in a log we failed to redact.
 *
 * Two independent capabilities, each pure and side-effect-free:
 *   1. `generateSessionToken` — a fresh 256-bit CSPRNG token, base64url so it is
 *      safe in a cookie or an `Authorization` header. The plaintext is returned
 *      to the caller exactly once; only its hash is ever persisted.
 *   2. `hashSessionToken`      — the deterministic SHA-256 digest stored in
 *      `sessions.token_hash` and re-derived on every request to look the row up.
 *
 * SHA-256 (not Argon2) is correct here for the same reason it is correct for API
 * keys and wrong for passwords: the token is high-entropy random with no
 * dictionary, so the digest only needs to be one-way and fast, not slow. See
 * `@/auth/password` for the contrast.
 *
 * This module owns no persistence and no authentication logic. Storing a
 * session, looking one up, and deciding whether a caller is authenticated all
 * live elsewhere (`@/auth/session-store`, `@/auth/session-authenticator`), so the
 * token utility can be reasoned about and tested in complete isolation.
 */

import { createHash, randomBytes } from 'node:crypto';

/** Token entropy: 32 bytes = 256 bits of CSPRNG output. */
export const SESSION_TOKEN_BYTES = 32;

/**
 * Mint a fresh opaque session token. Cryptographically random, unpredictable,
 * and carrying no embedded identity — base64url-encoded for transport safety.
 * The returned plaintext is the only copy; persist `hashSessionToken(token)`.
 */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/**
 * Derive the durable lookup digest for a token. Deterministic, so the same token
 * always resolves to the same `sessions.token_hash`; one-way, so the stored hash
 * does not reveal the token. Hex-encoded to match `api_keys.key_hash`.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
