import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/test/**/*.test.ts'],
    // The first test to build a Fastify app pays a one-time cost (plugin
    // registration plus cold module transform under vitest) that can exceed the
    // 5s default on a slow machine. Steady-state runs are milliseconds.
    testTimeout: 20_000,
  },
});
