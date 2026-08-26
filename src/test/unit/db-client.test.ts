/**
 * Unit tests for the database layer's configuration and lifecycle.
 *
 * These do **not** require PostgreSQL. Constructing a `pg.Pool` performs no I/O,
 * so pool wiring, URL redaction and shutdown are all observable offline.
 *
 * One test does open a TCP socket — deliberately, to a port nothing can be
 * listening on — because "fails fast with a clear, credential-free error when the
 * database is unreachable" is a behaviour worth proving rather than assuming.
 * Real schema and query behaviour is covered in src/test/integration.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv } from '@/config/env.js';
import { createDatabase, describeDatabaseUrl } from '@/db/client.js';
import type { DatabaseHandle } from '@/db/client.js';
import { RetryableError, isRetryable } from '@/domain/errors.js';
import { createLogger } from '@/observability/logger.js';

/** Reserved port 1: nothing binds it, so connections are refused immediately. */
const UNREACHABLE_URL = 'postgresql://app:sup3rs3cret@127.0.0.1:1/ai_workforce';

const silentLogger = createLogger(parseEnv({ DATABASE_URL: UNREACHABLE_URL, LOG_LEVEL: 'silent' }), {
  service: 'test',
});

const opened: DatabaseHandle[] = [];

/** Every handle created by a test is drained afterwards, pass or fail. */
function open(source: Record<string, string>): DatabaseHandle {
  const handle = createDatabase(parseEnv(source), silentLogger, { service: 'test' });
  opened.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((handle) => handle.close()));
});

describe('describeDatabaseUrl', () => {
  it('keeps host, port and database and drops the credentials', () => {
    expect(
      describeDatabaseUrl('postgresql://app:sup3rs3cret@db.example.com:6543/ai_workforce'),
    ).toEqual({
      host: 'db.example.com',
      port: '6543',
      database: 'ai_workforce',
    });
  });

  it('never returns the password, under any part of the URL', () => {
    const described = describeDatabaseUrl(
      'postgresql://app:sup3rs3cret@db.example.com:5432/ai_workforce?sslmode=require',
    );

    expect(JSON.stringify(described)).not.toContain('sup3rs3cret');
    expect(JSON.stringify(described)).not.toContain('app');
  });

  it("assumes Postgres's default port when the URL omits one", () => {
    expect(describeDatabaseUrl('postgresql://db.example.com/main').port).toBe('5432');
  });

  it('percent-decodes the database name', () => {
    expect(describeDatabaseUrl('postgresql://h/ai%20workforce').database).toBe('ai workforce');
  });

  it('degrades to a placeholder rather than echoing an unparsable string', () => {
    const described = describeDatabaseUrl('not-a-url-at-all');

    expect(described.host).toBe('(unparsable)');
    expect(JSON.stringify(described)).not.toContain('not-a-url-at-all');
  });
});

describe('createDatabase', () => {
  it('opens no connection while being constructed', () => {
    const handle = open({ DATABASE_URL: UNREACHABLE_URL });

    expect(handle.pool.totalCount).toBe(0);
    expect(handle.pool.idleCount).toBe(0);
  });

  it('applies DATABASE_POOL_MAX to the pool', () => {
    const handle = open({ DATABASE_URL: UNREACHABLE_URL, DATABASE_POOL_MAX: '3' });

    expect(handle.pool.options.max).toBe(3);
  });

  it('tags connections with the service name for pg_stat_activity', () => {
    const handle = createDatabase(
      parseEnv({ DATABASE_URL: UNREACHABLE_URL }),
      silentLogger,
      { service: 'worker' },
    );
    opened.push(handle);

    expect(handle.pool.options.application_name).toBe('ai-workforce-worker');
  });

  it('exposes a typed drizzle instance and the underlying pool', () => {
    const handle = open({ DATABASE_URL: UNREACHABLE_URL });

    expect(typeof handle.db.select).toBe('function');
    expect(typeof handle.pool.query).toBe('function');
  });

  it('registers an error listener so a dead idle connection cannot kill the process', () => {
    // Without a listener, pg's `error` event on the pool becomes an unhandled
    // error event and Node terminates.
    const handle = open({ DATABASE_URL: UNREACHABLE_URL });

    expect(handle.pool.listenerCount('error')).toBeGreaterThan(0);
  });

  it('can be closed twice without throwing', async () => {
    const handle = open({ DATABASE_URL: UNREACHABLE_URL });

    await expect(handle.close()).resolves.toBeUndefined();
    await expect(handle.close()).resolves.toBeUndefined();
  });
});

describe('verifyConnection (unreachable database)', () => {
  it('rejects with a retryable database_unreachable error', async () => {
    const handle = open({ DATABASE_URL: UNREACHABLE_URL });

    const error = await handle.verifyConnection().then(
      () => {
        throw new Error('expected verifyConnection to reject');
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(RetryableError);
    expect(isRetryable(error)).toBe(true);
    expect((error as RetryableError).code).toBe('database_unreachable');
  });

  it('names the target but not the credentials, and keeps the cause', async () => {
    const handle = open({ DATABASE_URL: UNREACHABLE_URL });

    const error = (await handle.verifyConnection().catch((caught: unknown) => caught)) as
      RetryableError;

    expect(error.message).toContain('127.0.0.1:1/ai_workforce');
    expect(error.message).not.toContain('sup3rs3cret');
    expect(error.details).toEqual({ host: '127.0.0.1', port: '1', database: 'ai_workforce' });
    // The driver's own error is preserved for diagnosis (ECONNREFUSED etc.).
    expect(error.cause).toBeDefined();
  });
});
