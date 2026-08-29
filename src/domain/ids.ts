/**
 * Primary-key identifier generation.
 *
 * Every primary key in this system is a **UUIDv7**, generated in the application
 * rather than by the database. Two consequences of that choice drive everything
 * else here:
 *
 * 1. **UUIDv7, not v4.** A v7 UUID embeds a millisecond Unix timestamp in its
 *    high bits, so ids are *time-ordered*. Rows inserted close together sort and
 *    index near each other, which keeps B-tree inserts append-mostly instead of
 *    scattering them across the index — the property that matters for the
 *    high-insert tables coming later (`events`, `workflow_runs`, `step_runs`,
 *    `jobs`). A random v4 has none of that locality. We do not use v4 for any
 *    application primary key.
 *
 * 2. **Generated in Node, not Postgres.** Postgres only gained a built-in
 *    `uuidv7()` in version 18, but this project targets Postgres 13+. Rather than
 *    ship a custom PL/pgSQL function (over-engineering for what one library call
 *    does), ids are produced here and supplied on insert via Drizzle's
 *    `$defaultFn`. That keeps generation portable across every provider and every
 *    supported server version, and means an id is available without a round trip.
 *
 * The implementation is deliberately a single well-maintained library call. There
 * is nothing bespoke to get subtly wrong (clock handling, monotonicity within a
 * millisecond, RFC 9562 bit layout) — `uuid`'s `v7` already handles it.
 */

import { v7 as uuidv7 } from 'uuid';

/** A fresh time-ordered UUIDv7, as the canonical 36-character string. */
export function newId(): string {
  return uuidv7();
}
