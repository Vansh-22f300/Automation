import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Load .env in the main process before workers spawn, so TEST_DATABASE_URL (and
// anything else the suites read) is visible to every test worker. Mirrors the
// pattern in drizzle.config.ts; the file is optional. Node's built-in loader.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env present — rely on the ambient environment.
}

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Two projects with deliberately different execution models:
    //   - unit: no database, safe to run files in parallel (the default);
    //   - integration: one shared PostgreSQL test database, so files must NOT
    //     race. A single fork serialises them, and a one-time global setup
    //     migrates the schema before any of them run.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/test/unit/**/*.test.ts'],
          environment: 'node',
          // The first test to build a Fastify app pays a one-time cold-start
          // cost that can exceed the 5s default on a slow machine.
          testTimeout: 20_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
          // Migrate the test database exactly once, before any suite imports.
          globalSetup: ['./src/test/integration/global-setup.ts'],
          // Serialise the DB layer: all integration files share one test
          // database (with cross-suite table wipes), so they cannot run
          // concurrently without corrupting each other.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
