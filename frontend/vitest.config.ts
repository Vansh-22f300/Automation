import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration — two isolated projects under one `vitest run`.
 *
 * `server`  — the BFF end-to-end + client-unit tests. `@nuxt/test-utils`'s
 *   `setup()` builds and boots a real Nuxt/Nitro server in a subprocess and the
 *   specs exercise the actual `/backend/*` route over HTTP against a per-file
 *   `node:http` upstream mock. These MUST run in the plain `node` environment
 *   with NO Vue/Nuxt Vite pipeline in-process (see the long-standing note below).
 *
 * `components` — in-process component tests for the small logged-out pages and
 *   the sidebar. These compile our own SFCs with the vanilla `@vitejs/plugin-vue`
 *   plugin (NOT Nuxt's Vite pipeline) in `happy-dom`, so they never touch
 *   `nuxt-root.vue` and are unaffected by the magic-string interop bug that makes
 *   `environment: 'nuxt'` unusable here. Nuxt auto-imports and `<NuxtLink>` are
 *   provided as lightweight stubs by the setup file.
 *
 * Keeping the two apart means the server suite's Nitro build never has a Vue
 * plugin injected into it, and the component suite never boots a Nitro server.
 */
const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['tests/integration/**/*.spec.ts', 'tests/unit/**/*.spec.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
          pool: 'forks',
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
        },
      },
      {
        plugins: [vue()],
        resolve: {
          alias: {
            '~~': rootDir,
            '@@': rootDir,
            '~': rootDir,
            '@': rootDir,
          },
        },
        test: {
          name: 'components',
          environment: 'happy-dom',
          include: ['tests/components/**/*.spec.ts'],
          setupFiles: ['tests/components/helpers/nuxt-stubs.ts'],
        },
      },
    ],
  },
});
