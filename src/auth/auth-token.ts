/**
 * Auth-token primitives — generation and hashing for the *email* tokens
 * (verification links and password-reset links), and nothing else.
 *
 * These tokens are the direct siblings of the session token in `@/auth/
 * session-token`: an opaque high-entropy bearer secret that means nothing on its
 * own. Everything about it — which user it belongs to, what it is for, when it
 * expires, whether it has been spent — lives in the `auth_tokens` row its hash
 * points at, never in the token. That is deliberate: an opaque token cannot be
 * tampered into naming a different user or purpose, and it discloses nothing if
 * it ever slips into a log we failed to redact.
 *
 * Two pure, side-effect-free capabilities:
 *   1. `generateAuthToken` — a fresh 256-bit CSPRNG token, base64url so it is
 *      safe in a URL query string or path. The plaintext is returned to the
 *      caller exactly once; only its hash is ever persisted, and it is placed in
 *      the email link and nowhere else.
 *   2. `hashAuthToken`     — the deterministic SHA-256 digest stored in
 *      `auth_tokens.token_hash` and re-derived to consume the token.
 *
 * SHA-256 (not Argon2) is correct here for the same reason it is for session
 * tokens and API keys: the token is high-entropy random with no dictionary, so
 * the digest only needs to be one-way and fast. See `@/auth/password` for the
 * contrast, and `@/auth/session-token` for the identical session-side utility —
 * kept separate on purpose so neither concern can drift into the other.
 *
 * This module owns no persistence and no policy (expiry lifetimes live with the
 * notifier that mints links; storage lives in `@/auth/auth-token-store`), so it
 * can be reasoned about and tested in complete isolation.
 */

import { createHash, randomBytes } from 'node:crypto';

/** Token entropy: 32 bytes = 256 bits of CSPRNG output. */
export const AUTH_TOKEN_BYTES = 32;

/**
 * Mint a fresh opaque auth token. Cryptographically random, unpredictable, and
 * carrying no embedded identity — base64url-encoded so it is safe to place in a
 * verification / reset URL. The returned plaintext is the only copy; persist
 * `hashAuthToken(token)`, never the token.
 */
export function generateAuthToken(): string {
  return randomBytes(AUTH_TOKEN_BYTES).toString('base64url');
}

/**
 * Derive the durable lookup digest for a token. Deterministic, so the same token
 * always resolves to the same `auth_tokens.token_hash`; one-way, so the stored
 * hash does not reveal the token. Hex-encoded to match the other auth hashes.
 */
export function hashAuthToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
