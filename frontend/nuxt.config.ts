import { defineNuxtConfig } from 'nuxt/config';

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
    // Server-only. Empty-string default so the API key is NEVER read from
    // `process.env` at build time (which would serialize the secret into the
    // Nitro server bundle). Nuxt overrides this at runtime from the matching
    // `NUXT_API_KEY` environment variable.
    apiKey: '',
    // Server-only. Safe non-secret localhost default for local development;
    // overridden at runtime from `NUXT_BACKEND_URL` in deployed environments.
    backendUrl: 'http://127.0.0.1:3000',
    // Server-only. Non-secret numeric default; overridden at runtime from
    // `NUXT_BFF_TIMEOUT_MS`. The BFF route and forwarder both re-validate and
    // clamp the effective value to the inclusive range [100, 60000] ms.
    bffTimeoutMs: 10_000,
    // Server-only. Comma-separated list of extra origins the BFF's CSRF check
    // accepts on state-changing auth routes, IN ADDITION to this server's own
    // origin. Empty by default (same-origin only). Overridden at runtime from
    // `NUXT_TRUSTED_ORIGINS`. Never a broad wildcard such as `*.vercel.app`.
    trustedOrigins: '',
    public: {
      // Client-side: the same-origin path the browser uses to reach the BFF.
      // Sourced from `NUXT_PUBLIC_API_BASE`.
      apiBase: process.env.NUXT_PUBLIC_API_BASE ?? '/backend',
    },
  },
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'AI Workforce',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#050508' },
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