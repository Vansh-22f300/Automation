/**
 * drizzle-kit configuration — used by the `pnpm db:*` scripts only. This file is
 * tooling, not application code; nothing under src/ imports it.
 *
 * `db:generate` diffs src/db/schema.ts against the existing SQL in drizzle/ and
 * writes a new migration. It needs no database, which is what keeps `pnpm build`
 * and CI free of any live-Postgres requirement. Only `db:migrate`, `db:push` and
 * `db:studio` actually connect, and those fail with drizzle-kit's own error if
 * DATABASE_URL is unset — hence the tolerant fallback below rather than a
 * hardcoded placeholder connection string.
 */

import { defineConfig } from 'drizzle-kit';

// Node's built-in .env loader; the file is optional, so a missing one is fine.
// The `pnpm db:*` scripts cannot pass --env-file to drizzle-kit's own process.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env present. Real environment variables are used as-is.
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  // Print the SQL and ask before running anything destructive.
  verbose: true,
  strict: true,
});
