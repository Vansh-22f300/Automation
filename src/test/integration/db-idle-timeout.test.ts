/**
 * Integration — verifies the idle_in_transaction_session_timeout session guard.
 *
 * Why this file exists: unit tests prove the pool is *configured* with the right
 * startup parameter, but only a real PostgreSQL session can prove PostgreSQL
 * actually *observed* it. Neon exposes the same pg wire protocol, so the
 * startup parameter works there too (Neon docs: session-level GUCs apply even
 * behind Neon's proxy / pgbouncer in transaction mode — the value is sent on
 * connection startup, before any pooling layer).
 *
 * Verification limits (documented):
 *   - We can prove `SHOW` reports the expected value on a checked-out session
 *     and inside `BEGIN …` transactions — that the guard is active.
 *   - We cannot deterministically prove the *abort* without actually idling
 *     30s inside a transaction, which would make the test flaky/slow. Instead we
 *     prove the guard is present and relies on PostgreSQL's documented behaviour
 *     (idle_in_transaction_session_timeout → 25P03 termination) rather than
 *     re-implementing a slow sleep.
 *   - Neon-specific proxy quirks (if any) can only be verified against a real
 *     Neon endpoint; the mechanism used (startup parameter) is the documented
 *     portable one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '@/db/client.js';
import { DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS } from '@/db/client.js';

import { TEST_DATABASE_URL, createTestDatabaseHandle } from './support.js';

describe.skipIf(TEST_DATABASE_URL === undefined)('db idle_in_transaction_session_timeout', () => {
  let handle: DatabaseHandle;

  beforeAll(async () => {
    handle = createTestDatabaseHandle();
    await handle.verifyConnection();
  });

  afterAll(async () => {
    if (handle !== undefined) await handle.close();
  });

  it('exposes the configured timeout on every checked-out session', async () => {
    const result = await handle.pool.query<{ idle_in_transaction_session_timeout: string }>(
      'SHOW idle_in_transaction_session_timeout',
    );
    const raw = result.rows[0]?.idle_in_transaction_session_timeout;
    // PostgreSQL formats as e.g. "30s"; pg's startup value is milliseconds, so
    // the server may echo either "30s" or "30000". Accept both.
    const asMs = raw === undefined ? -1 : parsePostgresTimeoutToMs(String(raw));
    expect(asMs).toBe(DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS);
  });

  it('retains the guard inside an explicit transaction', async () => {
    // Use a single checked-out client so BEGIN/SHOW/COMMIT are on the same
    // session — proves the GUC is session-scoped, not lost on BEGIN, exactly
    // how the execution engine's beginStep/settleStep transactions behave.
    const client = await handle.pool.connect();
    try {
      await client.query('BEGIN');
      const inside = await client.query<{ idle_in_transaction_session_timeout: string }>(
        'SHOW idle_in_transaction_session_timeout',
      );
      expect(parsePostgresTimeoutToMs(String(inside.rows[0]?.idle_in_transaction_session_timeout))).toBe(
        DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      );
      await client.query('COMMIT');
      // After COMMIT the session is still the same physical connection when
      // returned to the pool; the guard must still be present for the next
      // transaction on that connection.
      const after = await client.query<{ idle_in_transaction_session_timeout: string }>(
        'SHOW idle_in_transaction_session_timeout',
      );
      expect(parsePostgresTimeoutToMs(String(after.rows[0]?.idle_in_transaction_session_timeout))).toBe(
        DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      );
    } finally {
      client.release();
    }
  });

  it('leaves statement_timeout independent (idle guard does not clobber query cap)', async () => {
    const result = await handle.pool.query<{ statement_timeout: string }>('SHOW statement_timeout');
    const raw = String(result.rows[0]?.statement_timeout ?? '');
    // In integration support we override statement_timeout to 60s for the handle;
    // what matters is that it was not silently replaced by the idle guard.
    expect(parsePostgresTimeoutToMs(raw)).toBeGreaterThan(0);
    const idleRaw = (
      await handle.pool.query<{ idle_in_transaction_session_timeout: string }>(
        'SHOW idle_in_transaction_session_timeout',
      )
    ).rows[0]?.idle_in_transaction_session_timeout;
    expect(parsePostgresTimeoutToMs(String(idleRaw))).toBe(DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS);
  });
});

/**
 * PostgreSQL reports intervals like "30s", "500ms", "1min", or "30000".
 * Convert to milliseconds for deterministic assertion.
 */
function parsePostgresTimeoutToMs(value: string): number {
  const normalized = value.trim().toLowerCase();
  if (/^\d+$/.test(normalized)) return Number.parseInt(normalized, 10);
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/);
  if (match === null) return Number.NaN;
  const amount = Number.parseFloat(match[1]!);
  const unit = match[2] ?? 'ms';
  const factor: Record<string, number> = { ms: 1, s: 1_000, min: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * (factor[unit] ?? 1);
}
