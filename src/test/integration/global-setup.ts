/**
 * Vitest global setup for the integration project — runs ONCE per test run,
 * in the main process, before any integration file is imported.
 *
 * Its only job is to bring the test database's schema up to date exactly once.
 * Previously every suite ran `migrate()` in its own `beforeAll`; with Vitest
 * executing files concurrently, those runs raced to create the same enums,
 * tables and `drizzle.__drizzle_migrations`, producing duplicate-object errors.
 * Migrating here — once, serially — removes that race at its source.
 *
 * A no-op when TEST_DATABASE_URL is unset: the suites themselves skip, so there
 * is nothing to prepare and a unit-only run must not fail here.
 */

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { parseEnv } from '@/config/env.js';
import { createDatabase } from '@/db/client.js';
import { createLogger } from '@/observability/logger.js';

import { assertTestDatabase } from './support.js';

const MIGRATION_STATEMENT_TIMEOUT_MS = 300_000;

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url === '') return;

  assertTestDatabase(url);

  const env = parseEnv({ DATABASE_URL: url, LOG_LEVEL: 'silent' });
  const handle = createDatabase(env, createLogger(env, { service: 'test-migrate' }), {
    service: 'test-migrate',
    statementTimeoutMs: MIGRATION_STATEMENT_TIMEOUT_MS,
  });

  try {
    await handle.verifyConnection();
    await migrate(handle.db, { migrationsFolder: 'drizzle' });
  } finally {
    await handle.close();
  }
}
