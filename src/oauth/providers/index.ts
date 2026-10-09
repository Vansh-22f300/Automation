/**
 * OAuth provider assembly.
 *
 * `loadOAuthProviders` is the one place that decides which OAuth providers a
 * process registers, based solely on validated environment configuration. A
 * provider that is not configured is simply absent, and the registry fails
 * closed for it (an `unknown_provider` error), so there is never a
 * half-configured provider. Both the API server and the worker call this.
 */
import type { Env } from '../../config/env.js';
import type { OAuthProviderConfig } from '../provider-config.js';
import { createGithubProviderConfig } from './github.js';

export {
  GITHUB_PROVIDER,
  GITHUB_API_BASE,
  GITHUB_DEFAULT_SCOPES,
  createGithubProviderConfig,
} from './github.js';

/**
 * The OAuth provider configs this process should register, derived from env.
 * Currently GitHub only; add further providers by appending their
 * `create…ProviderConfig(env)` result and filtering out the undefined ones.
 */
export function loadOAuthProviders(env: Env): OAuthProviderConfig[] {
  return [createGithubProviderConfig(env)].filter(
    (config): config is OAuthProviderConfig => config !== undefined,
  );
}
