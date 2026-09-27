/**
 * Structural, non-weakening composition of the two authenticators.
 *
 * The protected `/v1/*` surface must accept *both* machine API keys (webhooks,
 * CLI, CI, the worker) and human browser sessions (forwarded by the same-origin
 * BFF), each resolving to its own tenant. This authenticator routes a bearer
 * credential to exactly one of the underlying authenticators by the credential's
 * *structure* — it never tries both, never falls back, and never relaxes either
 * one's rules:
 *
 *   - An API key is exactly `awk_` + base64url (≥12 chars). `parseApiKey`
 *     returns non-null only for that shape, so a key goes to the
 *     `ApiKeyAuthenticator` unchanged.
 *   - A session token is an opaque 256-bit base64url string with no `awk_`
 *     prefix, so `parseApiKey` returns null and it goes to the
 *     `SessionAuthenticator` unchanged.
 *
 * Because the two credential shapes are disjoint, this composition adds no new
 * way to authenticate: every credential reaches the same authenticator it would
 * have reached on a dedicated scope, with the same accept/reject outcome. The
 * tenant is always established by whichever authenticator ran (from the API-key
 * row or the session row) — never from anything the caller can choose.
 */

import { parseApiKey } from '@/auth/api-key.js';
import type { AuthContext, Authenticator } from '@/auth/context.js';

export class CompositeAuthenticator implements Authenticator {
  constructor(
    private readonly apiKeyAuthenticator: Authenticator,
    private readonly sessionAuthenticator: Authenticator,
  ) {}

  async authenticate(credential: string): Promise<AuthContext> {
    // Route by structure only. A well-formed API key can never be mistaken for
    // a session token and vice versa, so there is no ambiguous credential and
    // no second attempt: exactly one authenticator sees the credential.
    if (parseApiKey(credential) !== null) {
      return this.apiKeyAuthenticator.authenticate(credential);
    }
    return this.sessionAuthenticator.authenticate(credential);
  }
}
