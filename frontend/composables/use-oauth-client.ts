import { OAuthClient } from '~/lib/oauth-client';

/**
 * Returns a browser-side GitHub-connect client pointed at the same-origin BFF.
 *
 * Mirrors {@link useApiClient}: the browser only needs the BFF base path
 * (`runtimeConfig.public.apiBase`). The HttpOnly session cookie and every OAuth
 * secret stay server-side; the browser never sees or sends them.
 */
export function useOAuthClient(): OAuthClient {
  const config = useRuntimeConfig();
  return new OAuthClient({ baseUrl: config.public.apiBase });
}
