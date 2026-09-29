/**
 * The OAuth HTTP surface (state design §14): three thin Fastify handlers over
 * {@link OAuthService}. They own no security logic — they read the trusted
 * session context, validate request shape, call the service, and translate its
 * domain errors into the shared HTTP envelope.
 *
 * THE TWO TRUST ZONES.
 *   - `POST /v1/oauth/:provider/authorize` and
 *     `POST /v1/oauth/connections/:id/disconnect` are AUTHENTICATED. They run
 *     inside the `/v1/*` scope and additionally demand a *human session*
 *     (`requireHumanSession`), so tenant and user are taken from the verified
 *     session — never the body — and a machine API key (no `userId`) is refused
 *     with a 401. This is the §14 guarantee: the initiating tenant/user are
 *     server-established, not client-supplied.
 *   - `GET /oauth/:provider/callback` is PUBLIC and UNAUTHENTICATED — the browser
 *     arrives with only `state` and `code`. It is registered as a sibling of the
 *     health/auth routes so no auth hook runs on it. Every trusted fact (tenant,
 *     user, provider, return path, PKCE verifier) is recovered from the consumed
 *     state row inside the service; the query is trusted for nothing but the
 *     opaque `state` and `code`, and the route `:provider` is used only as a
 *     match predicate on the consume.
 *
 * ERROR TRANSLATION. The service throws framework-free domain errors
 * ({@link OAuthStateInvalidError}, {@link OAuthProviderError}, …) that are NOT
 * `ApiError`s, so `rethrowAsApiError` maps them onto the client-safe envelope: an
 * invalid/expired/replayed/mismatched state and a rejected exchange become a 400,
 * an unregistered provider a non-enumerable 404, and a transient provider outage
 * is left to surface as a generic 500. No provider text ever crosses the boundary.
 */

import { z } from 'zod';

import { requireHumanSession } from '@/api/auth-hook.js';
import { BadRequestError, isApiError, NotFoundError } from '@/api/errors.js';
import type { ApiServer } from '@/api/types.js';
import { OAuthProviderError, OAuthStateInvalidError } from '@/oauth/errors.js';
import type { OAuthService } from '@/oauth/oauth-service.js';
import { isValidProviderSlug } from '@/oauth/provider-config.js';

/** `:provider` is attacker-controlled; bound its length before anything else. */
const providerParams = z.object({ provider: z.string().min(1).max(64) });

/** Disconnect targets one connection id in the caller's own tenant. */
const disconnectParams = z.object({ id: z.string().min(1).max(64) });

/** The callback observes only these two query values; both are required. */
const callbackQuery = z.object({
  state: z.string().min(1).max(4096),
  code: z.string().min(1).max(4096),
});

/**
 * Authorize takes only optional shaping: an internal return path (re-validated
 * server-side by the service) and a scope override. Unknown keys are stripped,
 * so a client cannot smuggle a tenant/user/provider into the flow.
 */
const authorizeBody = z.object({
  returnPath: z.string().min(1).max(512).optional(),
  scopes: z.array(z.string().min(1).max(256)).max(64).optional(),
});

/** Map a service-thrown domain error onto the client-safe HTTP envelope. */
function rethrowAsApiError(error: unknown): never {
  // A validation `ApiError` raised inside the service (e.g. an unsafe return
  // path) is already client-safe — let it through with its own status.
  if (isApiError(error)) throw error;
  if (error instanceof OAuthStateInvalidError) {
    throw new BadRequestError('The OAuth state is invalid, expired, or has already been used.');
  }
  if (error instanceof OAuthProviderError) {
    // Fail closed and non-enumerable: an unregistered (or malformed) provider is
    // a 404 exactly like a missing resource; any other deterministic provider
    // rejection (e.g. a bad authorization code) is a 400. No provider text leaks.
    const reason = error.details?.reason;
    if (reason === 'unknown_provider') throw new NotFoundError('OAuth provider not found');
    throw new BadRequestError('The OAuth provider rejected the request.');
  }
  // A transient upstream failure (OAuthProviderUnavailableError) or anything
  // unforeseen: the central handler logs the detail and returns a generic 500.
  // Never surface the provider's response body.
  throw error;
}

/**
 * Register the AUTHENTICATED OAuth routes on the protected `/v1/*` scope. Both
 * demand a human session, so the tenant/user come from the verified session and
 * a machine API-key caller (no `userId`) is refused with a 401.
 */
export function registerOAuthRoutes(app: ApiServer, oauthService: OAuthService): void {
  // Begin an authorization: mint state + PKCE, persist the sealed row bound to
  // this session's tenant/user, and hand back the provider URL to redirect to.
  app.post('/v1/oauth/:provider/authorize', async (request, reply) => {
    const { userId, tenantId } = requireHumanSession(request);

    const params = providerParams.safeParse(request.params);
    if (!params.success || !isValidProviderSlug(params.data.provider)) {
      // Malformed or non-allowlisted slug — 404, indistinguishable from unknown.
      throw new NotFoundError('OAuth provider not found');
    }

    const body = authorizeBody.safeParse(request.body ?? {});
    if (!body.success) {
      throw new BadRequestError(body.error.issues[0]?.message ?? 'Invalid request body');
    }

    try {
      const result = await oauthService.beginAuthorization({
        tenantId,
        userId,
        provider: params.data.provider,
        ...(body.data.returnPath !== undefined ? { returnPath: body.data.returnPath } : {}),
        ...(body.data.scopes !== undefined ? { scopes: body.data.scopes } : {}),
      });
      return reply.code(200).send({ authorizationUrl: result.authorizationUrl });
    } catch (error) {
      rethrowAsApiError(error);
    }
  });

  // Disconnect a connection in the caller's own tenant: best-effort provider
  // revoke, then disable the local row. 404 when no such connection exists here.
  app.post('/v1/oauth/connections/:id/disconnect', async (request, reply) => {
    const { tenantId } = requireHumanSession(request);

    const params = disconnectParams.safeParse(request.params);
    if (!params.success) {
      throw new BadRequestError('Invalid connection id');
    }

    try {
      const disconnected = await oauthService.disconnect({
        tenantId,
        connectionId: params.data.id,
      });
      if (!disconnected) {
        throw new NotFoundError('Connection not found');
      }
      return reply.code(204).send();
    } catch (error) {
      rethrowAsApiError(error);
    }
  });
}

/**
 * Register the PUBLIC OAuth callback as a sibling of the health/auth routes, so
 * no auth hook runs on it. It trusts nothing from the query but `state`/`code`;
 * the tenant, user, provider, return path, and PKCE verifier are all recovered
 * from the atomically-consumed state row inside the service.
 */
export function registerOAuthCallbackRoute(app: ApiServer, oauthService: OAuthService): void {
  app.get('/oauth/:provider/callback', async (request, reply) => {
    // `:provider` is used only as the consume match predicate; a malformed slug
    // simply matches no row and yields the same undifferentiated invalid-state
    // 400 as any other bad state — so it is not an enumeration oracle.
    const params = providerParams.safeParse(request.params);
    const query = callbackQuery.safeParse(request.query);
    if (!params.success || !query.success) {
      // A denial callback (`?error=access_denied`, no `code`) also lands here.
      throw new BadRequestError('The OAuth callback is missing its state or code.');
    }

    try {
      const result = await oauthService.completeCallback({
        provider: params.data.provider,
        state: query.data.state,
        code: query.data.code,
      });
      // The return path was validated as a safe internal path at authorize time
      // and recovered from the consumed row — never taken from this request — so
      // the redirect cannot be steered to an external origin.
      return reply.redirect(result.returnPath);
    } catch (error) {
      rethrowAsApiError(error);
    }
  });
}
