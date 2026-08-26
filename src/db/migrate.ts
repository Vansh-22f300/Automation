/**
 * Migration runner.
 *
 * Applies every pending SQL file in `drizzle/` inside a transaction, recording
 * what it applied in `drizzle.__drizzle_migrations`. Safe to run repeatedly —
 * already-applied migrations are skipped.
 *
 * This exists as an application script rather than relying on `drizzle-kit
 * migrate` because it is what runs in production: it reuses the same validated
 * config and the same pool construction as the services, so there is no second
 * way to specify a database and no chance of the two disagreeing.
 *
 *   pnpm db:migrate          # from source, via tsx
 *   node dist/db/migrate.js  # from a built image, before starting the API
 */

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { loadEnv } from '@/config/env.js';
import { createDatabase } from '@/db/client.js';
import { createLogger } from '@/observability/logger.js';

/** DDL on a large table can take a while; the default 30s cap is too tight. */
const MIGRATION_STATEMENT_TIMEOUT_MS = 300_000;

const MIGRATIONS_FOLDER = 'drizzle';

const env = loadEnv();
const logger = createLogger(env, { service: 'migrate' });

const database = createDatabase(env, logger, {
  service: 'migrate',
  statementTimeoutMs: MIGRATION_STATEMENT_TIMEOUT_MS,
});

try {
  await database.verifyConnection();
  logger.info({ folder: MIGRATIONS_FOLDER }, 'applying migrations');
  await migrate(database.db, { migrationsFolder: MIGRATIONS_FOLDER });
  logger.info('migrations up to date');
} catch (error) {
  logger.fatal({ err: error }, 'migration failed');
  process.exitCode = 1;
} finally {
  await database.close();
}
