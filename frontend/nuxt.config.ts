import { defineNuxtConfig } from 'nuxt/config';

const backendUrl = process.env.NUXT_BACKEND_URL ?? 'http://127.0.0.1:3000';

export default defineNuxtConfig({
  compatibilityDate: '2026-09-06',
  ssr: false,
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE ?? '/backend',
      apiKey: process.env.NUXT_PUBLIC_API_KEY ?? '',
    },
  },
  vite: {
    server: {
      proxy: {
        '/backend': {
          target: backendUrl,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/backend/, ''),
        },
      },
    },
  },
  app: {
    head: {
      title: 'AI Workforce',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#f7f8fc' },
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
