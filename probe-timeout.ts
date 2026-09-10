#!/usr/bin/env tsx
/**
 * Diagnostic probe for PostgreSQL session timeouts.
 * Compares startup vs options vs explicit SET through actual TEST_DATABASE_URL.
 *
 * Safety:
 * - Never prints DATABASE_URL or credentials (host redacted via describeDatabaseUrl).
 * - Uses existing project env loading (process.loadEnvFile('.env') if present).
 * - Does not modify data (only SHOW, SET, BEGIN/COMMIT on empty transactions).
 * - Does not sleep.
 *
 * Run:  TEST_DATABASE_URL=... npx tsx probe-timeout.ts
 * Or via pnpm: TEST_DATABASE_URL=... pnpm exec tsx probe-timeout.ts
 */
try { process.loadEnvFile('.env'); } catch {}

import pg from 'pg';
import { describeDatabaseUrl } from './src/db/client.js';

function parseMs(v: string): number {
  const s = v.trim().toLowerCase();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]!);
  const u = m[2] || 'ms';
  const f: Record<string, number> = { ms: 1, s: 1000, min: 60000, h: 3600000, d: 86400000 };
  return n * (f[u] ?? 1);
}

async function getShows(client: pg.PoolClient | pg.Pool) {
  const idleRes = await (client as any).query('SHOW idle_in_transaction_session_timeout');
  const stmtRes = await (client as any).query('SHOW statement_timeout');
  const idleRaw = String(idleRes.rows[0]?.idle_in_transaction_session_timeout ?? '');
  const stmtRaw = String(stmtRes.rows[0]?.statement_timeout ?? '');
  return { idleMs: parseMs(idleRaw), stmtMs: parseMs(stmtRaw), idleRaw, stmtRaw };
}

const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) {
  console.log('TEST_DATABASE_URL not set — probe skipped.');
  console.log('Set TEST_DATABASE_URL=postgresql://.../ai_workforce_test and re-run: npx tsx probe-timeout.ts');
  process.exit(0);
}

const target = describeDatabaseUrl(TEST_URL);
console.log(`Probing TEST_DATABASE_URL target: host=${target.host} port=${target.port} database=${target.database} (credentials redacted)`);

async function probeA() {
  console.log('\n=== CASE A: startup PoolConfig only (statement_timeout=30000, idle=30000) ===');
  const pool = new pg.Pool({
    connectionString: TEST_URL,
    statement_timeout: 30000,
    idle_in_transaction_session_timeout: 30000,
    application_name: 'probe-A',
  });
  try {
    const c = await pool.connect();
    try {
      const init = await getShows(c);
      console.log(`A initial: idle=${init.idleRaw} (${init.idleMs}ms) statement=${init.stmtRaw} (${init.stmtMs}ms)`);
      await c.query('BEGIN');
      const inside = await getShows(c);
      console.log(`A inside BEGIN: idle=${inside.idleRaw} (${inside.idleMs}ms) statement=${inside.stmtRaw} (${inside.stmtMs}ms)`);
      await c.query('COMMIT');
      const after = await getShows(c);
      console.log(`A after COMMIT: idle=${after.idleRaw} (${after.idleMs}ms) statement=${after.stmtRaw} (${after.stmtMs}ms)`);
    } finally { c.release(); }
    const c2 = await pool.connect();
    try {
      const reacq = await getShows(c2);
      console.log(`A after reacquire: idle=${reacq.idleRaw} (${reacq.idleMs}ms) statement=${reacq.stmtRaw} (${reacq.stmtMs}ms)`);
    } finally { c2.release(); }
  } finally { await pool.end(); }
}

async function probeB() {
  console.log('\n=== CASE B: startup + options (-c ...) ===');
  const pool = new pg.Pool({
    connectionString: TEST_URL,
    statement_timeout: 30000,
    idle_in_transaction_session_timeout: 30000,
    options: '-c statement_timeout=30000 -c idle_in_transaction_session_timeout=30000',
    application_name: 'probe-B',
  } as any);
  try {
    const c = await pool.connect();
    try {
      const init = await getShows(c);
      console.log(`B initial: idle=${init.idleRaw} (${init.idleMs}ms) statement=${init.stmtRaw} (${init.stmtMs}ms) [1:applied on initial checkout]`);
      await c.query('BEGIN');
      const inside = await getShows(c);
      console.log(`B inside BEGIN: idle=${inside.idleRaw} (${inside.idleMs}ms) statement=${inside.stmtRaw} (${inside.stmtMs}ms) [2:preserved inside BEGIN]`);
      await c.query('COMMIT');
      const after = await getShows(c);
      console.log(`B after COMMIT: idle=${after.idleRaw} (${after.idleMs}ms) statement=${after.stmtRaw} (${after.stmtMs}ms) [3:preserved after COMMIT]`);
    } finally { c.release(); }
    const c2 = await pool.connect();
    try {
      const reacq = await getShows(c2);
      console.log(`B after reacquire: idle=${reacq.idleRaw} (${reacq.idleMs}ms) statement=${reacq.stmtRaw} (${reacq.stmtMs}ms) [4:preserved after reacquire]`);
    } finally { c2.release(); }
  } finally { await pool.end(); }
}

async function probeC() {
  console.log('\n=== CASE C: explicit SET after checkout ===');
  const pool = new pg.Pool({
    connectionString: TEST_URL,
    application_name: 'probe-C',
  });
  try {
    const c = await pool.connect();
    try {
      await c.query('SET statement_timeout = 30000');
      await c.query('SET idle_in_transaction_session_timeout = 30000');
      const afterSet = await getShows(c);
      console.log(`C after SET: idle=${afterSet.idleRaw} (${afterSet.idleMs}ms) statement=${afterSet.stmtRaw} (${afterSet.stmtMs}ms)`);
      await c.query('BEGIN');
      const inside = await getShows(c);
      console.log(`C inside BEGIN: idle=${inside.idleRaw} (${inside.idleMs}ms) statement=${inside.stmtRaw} (${inside.stmtMs}ms)`);
      await c.query('COMMIT');
      const afterCommit = await getShows(c);
      console.log(`C after COMMIT: idle=${afterCommit.idleRaw} (${afterCommit.idleMs}ms) statement=${afterCommit.stmtRaw} (${afterCommit.stmtMs}ms)`);
    } finally { c.release(); }
    const c2 = await pool.connect();
    try {
      const reacq = await getShows(c2);
      console.log(`C after reacquire (before re-SET): idle=${reacq.idleRaw} (${reacq.idleMs}ms) statement=${reacq.stmtRaw} (${reacq.stmtMs}ms) [SET survives reacquire?]`);
      await c2.query('SET statement_timeout = 30000');
      await c2.query('SET idle_in_transaction_session_timeout = 30000');
      await c2.query('BEGIN');
      const inside2 = await getShows(c2);
      console.log(`C second BEGIN after re-SET: idle=${inside2.idleRaw} (${inside2.idleMs}ms) statement=${inside2.stmtRaw} (${inside2.stmtMs}ms)`);
      await c2.query('COMMIT');
    } finally { c2.release(); }
  } finally { await pool.end(); }
}

// quick synthetic check
console.log('\n--- Synthetic PoolConfig (no I/O) ---');
{
  const pA = new pg.Pool({ connectionString: TEST_URL, statement_timeout: 30000, idle_in_transaction_session_timeout: 30000 } as any);
  console.log(`Synthetic A pool.options: statement_timeout=${(pA.options as any).statement_timeout} idle=${(pA.options as any).idle_in_transaction_session_timeout} options=${(pA.options as any).options ?? '(none)'}`);
  await pA.end();
  const pB = new pg.Pool({ connectionString: TEST_URL, statement_timeout: 30000, idle_in_transaction_session_timeout: 30000, options: '-c statement_timeout=30000 -c idle_in_transaction_session_timeout=30000' } as any);
  console.log(`Synthetic B pool.options: statement_timeout=${(pB.options as any).statement_timeout} idle=${(pB.options as any).idle_in_transaction_session_timeout} options=${(pB.options as any).options}`);
  await pB.end();
}

await probeA().catch(e => console.error('A failed', (e as Error).message));
await probeB().catch(e => console.error('B failed', (e as Error).message));
await probeC().catch(e => console.error('C failed', (e as Error).message));

console.log('\n=== TABLE TEMPLATE (fill from logs above) ===');
console.log('| Method | Initial SHOW | Inside BEGIN | After COMMIT | After reacquire | Conclusion |');
console.log('|---|---|---|---|---|---|');
console.log('| A | ... | ... | ... | ... | startup alone |');
console.log('| B | ... | ... | ... | ... | startup+options |');
console.log('| C | ... | ... | ... | ... | SET |');
