/**
 * PKCE (RFC 7636) primitives for the authorization-code flow.
 *
 * PKCE closes the "stolen authorization code" hole: the client commits to a
 * random `code_verifier` up front by sending only its SHA-256 digest (the
 * `code_challenge`, method `S256`) on the authorize request, then proves
 * possession of the verifier at the token exchange. A code intercepted in
 * transit is useless without the verifier, which never leaves the server.
 *
 * These are pure functions over `node:crypto`; the verifier is a secret and is
 * sealed at rest (see `@/oauth/state-secret-box`) — it is never logged and never
 * stored in plaintext.
 */

import { createHash, randomBytes } from 'node:crypto';

/**
 * 32 random bytes → a 43-character base64url string, comfortably inside RFC
 * 7636's 43–128 character range and high-entropy (256 bits).
 */
const VERIFIER_BYTES = 32;

/** The only challenge method this platform uses. Plain `S256`, never `plain`. */
export const CODE_CHALLENGE_METHOD = 'S256' as const;

/** Mint a fresh, high-entropy PKCE `code_verifier` (base64url, unreserved chars). */
export function generateCodeVerifier(): string {
  return randomBytes(VERIFIER_BYTES).toString('base64url');
}

/**
 * Derive the `code_challenge` from a verifier: base64url(SHA-256(verifier)).
 * The digest is not a secret (it is sent in the authorize URL), but the verifier
 * that produced it is.
 */
export function deriveCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
