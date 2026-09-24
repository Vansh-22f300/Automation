import { defineNuxtConfig } from 'nuxt/config';

/**
 * Parse a positive integer env var, falling back to `defaultValue` when the
 * input is missing, non-numeric, or out of the inclusive `[min, max]` range.
 */
function parsePositiveInt(
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return defaultValue;
  }
  return parsed;
}

/**
 * Frontend BFF configuration.
 *
 * The browser talks to the Nitro server at same-origin /backend/*. Nitro then
 * proxies the request to Fastify using a server-only API key. The browser never
 * sees the Fastify API key, never sends Authorization to Fastify, and never
 * sees CORS preflights: this config sets up the BFF and removes the old Vite
 * dev proxy.
 *
 * `apiKey` and `backendUrl` are SERVER-ONLY runtime config. They are read by
 * the Nitro route handler in `server/routes/backend/[...path].ts` and never
 * appear in `runtimeConfig.public`, so they never reach the browser.
 */
export default defineNuxtConfig({
  compatibilityDate: '2026-09-06',
  ssr: false,
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    // Server-only: the Fastify API key. Sourced from `NUXT_API_KEY`.
    apiKey: process.env.NUXT_API_KEY ?? '',
    // Server-only: the Fastify base URL. Sourced from `NUXT_BACKEND_URL`.
    backendUrl: process.env.NUXT_BACKEND_URL ?? 'http://127.0.0.1:3000',
    // Server-only: upstream timeout in milliseconds. Sourced from
    // `NUXT_BFF_TIMEOUT_MS`. Tests set this to a few hundred ms so the
    // timeout-exceeded path can be exercised without a 10 s wait.
    bffTimeoutMs: parsePositiveInt(process.env.NUXT_BFF_TIMEOUT_MS, 10_000, 100, 60_000),
    public: {
      // Client-side: the same-origin path the browser uses to reach the BFF.
      // Sourced from `NUXT_PUBLIC_API_BASE`.
      apiBase: process.env.NUXT_PUBLIC_API_BASE ?? '/backend',
    },
  },
  app: {
    head: {
      title: 'AI Workforce',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#f6f7f9' },
      ],
      link: [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap',
        },
      ],
    },
  },
  typescript: {
    strict: true,
    includeWorkspace: false,
    tsConfig: {
      exclude: ['../../src/**/*', '../../dist/**/*'],
    },
  },
});