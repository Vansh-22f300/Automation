import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for the frontend BFF end-to-end tests.
 *
 * These are end-to-end tests: `@nuxt/test-utils`'s `setup()` builds and boots a
 * real Nuxt/Nitro server in a subprocess, and the specs exercise the actual
 * `/backend/*` route over HTTP against a per-file `node:http` upstream mock
 * (see `tests/integration/helpers/upstream-mock.ts`).
 *
 * Per the Nuxt testing guide, e2e `setup()` tests run in the `node` environment
 * with a plain Vitest config — NOT `defineVitestConfig` / `environment: 'nuxt'`,
 * which is for in-process component/runtime tests and would pull Nuxt's Vite
 * (Vue SFC) pipeline into the Vitest process, where it is both unnecessary and
 * currently broken by a magic-string interop bug when compiling `nuxt-root.vue`.
 * The production `nuxt build` uses Nuxt's own Vite pipeline and is unaffected.
 *
 * No globals are injected: each test file imports only what it needs and
 * configures its own upstream mock, keeping the security assertions scoped to
 * one server lifecycle per file. `singleFork` serialises the files so their
 * servers and per-file `process.env` never overlap.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
