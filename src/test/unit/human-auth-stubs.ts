/**
 * Inert human-authentication dependencies for the HTTP-boundary suites that
 * exercise only the API-key `/v1/*` surface (or the public health routes).
 *
 * `buildApp` requires a `sessionAuthenticator` and an `authService` because the
 * assembled app *always* wires human auth additively alongside the API-key path
 * (see `server.ts`). Suites that never drive `/auth/*` still have to satisfy that
 * contract, so this returns fail-closed stand-ins: a session authenticator that
 * accepts no token and an auth service whose use-cases are never reached. Nothing
 * here loosens anything — an unused route that is asked to authenticate simply
 * 401s, exactly as production would if a caller presented no valid session.
 *
 * Suites that actually test `/auth/*` (auth-service.test.ts, the auth integration
 * suite) build real or behaviourally-faithful doubles instead and must not use
 * this.
 */

import { UnauthorizedError } from '@/api/errors.js';
import type { AuthService } from '@/auth/auth-service.js';
import type { AccountRecoveryService } from '@/auth/account-recovery-service.js';
import type { AuthContext, Authenticator } from '@/auth/context.js';
import type { OAuthService } from '@/oauth/oauth-service.js';

/**
 * An inert OAuth orchestrator for suites that never drive the OAuth routes.
 * `buildApp` requires an `oauthService` because it *always* registers the public
 * callback and the authenticated authorize/disconnect routes (see `server.ts`),
 * so suites that never send an OAuth request still have to satisfy that contract.
 * Registration only closes over the instance — no method is called — so a
 * stand-in whose use-cases throw is safe: an OAuth request that somehow reached
 * it would fault loudly rather than silently succeed.
 */
export function inertOAuthService(): OAuthService {
  return {
    beginAuthorization: async () => {
      throw new Error('not used');
    },
    completeCallback: async () => {
      throw new Error('not used');
    },
    disconnect: async () => {
      throw new Error('not used');
    },
  } as unknown as OAuthService;
}

export function inertHumanAuth(): {
  sessionAuthenticator: Authenticator;
  authService: AuthService;
  accountRecoveryService: AccountRecoveryService;
  oauthService: OAuthService;
} {
  return {
    oauthService: inertOAuthService(),
    sessionAuthenticator: {
      authenticate: async (): Promise<AuthContext> => {
        throw new UnauthorizedError();
      },
    },
    authService: {
      login: async () => {
        throw new Error('not used');
      },
      logout: async () => {
        throw new Error('not used');
      },
      getCurrentSession: async () => {
        throw new Error('not used');
      },
    } as unknown as AuthService,
    accountRecoveryService: {
      requestPasswordReset: async () => {
        throw new Error('not used');
      },
      resetPassword: async () => {
        throw new Error('not used');
      },
      verifyEmail: async () => {
        throw new Error('not used');
      },
      resendVerification: async () => {
        throw new Error('not used');
      },
    } as unknown as AccountRecoveryService,
  };
}
