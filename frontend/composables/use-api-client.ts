import { ApiClient } from '~/lib/api-client';

export function useApiClient(): ApiClient {
  const config = useRuntimeConfig();
  return new ApiClient({
    baseUrl: config.public.apiBase,
    apiKey: config.public.apiKey,
  });
}
