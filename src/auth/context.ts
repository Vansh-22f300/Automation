/**
 * The authentication seam.
 *
 * The rest of the application must be able to ask "who is calling?" without
 * knowing *how* the answer was obtained. Today the answer comes from an API key;
 * later it will also come from a user session, an OAuth token, or an RBAC-aware
 * identity provider. So the contract here is intentionally tiny and framework-
 * free: it mentions no HTTP, no Fastify request, no database.
 *
 * A route obtains an `AuthContext` and reads `tenantId` from it. When sessions
 * and OAuth arrive, they become additional `Authenticator` implementations and
 * additional (optional) fields on `AuthContext`; existing routes do not change.
 */

/**
 * The resolved identity behind a request. The minimum every tenant-scoped
 * operation needs, and the one field it may never proceed without: `tenantId`.
 *
 * Additive by design. `userId`, `scopes`, roles, etc. join it as later auth
 * mechanisms land — always optional, so an API-key caller (which has no user)
 * remains valid.
 */
export interface AuthContext {
  /** The tenant every downstream query must be scoped to. */
  readonly tenantId: string;
  /**
   * Which API key authenticated this request (for audit / last-used). Present
   * only for API-key callers; a human session leaves it absent. Optional so the
   * session path need not fabricate a key id it does not have.
   */
  readonly apiKeyId?: string;
  /**
   * Which user authenticated this request. Present only for human sessions; an
   * API-key caller (which acts as the tenant, not a person) leaves it absent.
   */
  readonly userId?: string;
}

/**
 * Turns an opaque credential string into an `AuthContext`, or rejects it.
 *
 * Implementations MUST throw `UnauthorizedError` for every failure mode rather
 * than returning null — a single rejection path keeps callers from having to
 * remember to check, and keeps every failure mapping to one 401.
 *
 * The credential is whatever was extracted from the transport (for API keys, the
 * bearer token). Keeping it a plain string is what lets this interface stay
 * ignorant of Fastify.
 */
export interface Authenticator {
  authenticate(credential: string): Promise<AuthContext>;
}
