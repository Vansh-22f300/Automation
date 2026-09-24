import { ApiClient } from '~/lib/api-client';

/**
 * Returns a browser-side Fastify API client.
 *
 * The browser only needs the same-origin path the BFF lives at
 * (`runtimeConfig.public.apiBase`). The BFF injects the server-only API key
 * on the server side, so the browser never sees or sends the Fastify API key.
 */
export function useApiClient(): ApiClient {
  const config = useRuntimeConfig();
  return new ApiClient({
    baseUrl: config.public.apiBase,
  });
}