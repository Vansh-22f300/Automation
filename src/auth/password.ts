/**
 * Password hashing — Argon2id, deliberately unlike the API-key path.
 *
 * API keys and passwords are hashed with different algorithms *on purpose*, and
 * this module must never borrow the api-key scheme. An API key is a 256-bit
 * random secret we mint: it has no dictionary and no reuse, so a single fast
 * SHA-256 is the right, sufficient tool (see `@/auth/api-key`). A password is a
 * low-entropy human secret, frequently reused, and must survive an offline dump:
 * that demands a slow, memory-hard KDF so a stolen `password_hash` cannot be
 * brute-forced cheaply. Those are opposite requirements, so they get opposite
 * primitives.
 *
 * The KDF is Argon2id via the `@node-rs/argon2` binding (prebuilt native, no
 * build step). We do not roll our own Argon2, and we do not reuse the AES
 * credential cipher — encryption is reversible, a password hash must not be.
 *
 * Discipline this module keeps:
 *   - the plaintext password is never stored, never logged, never returned;
 *   - `hash` emits a self-describing PHC string (`$argon2id$v=19$m=…,t=…,p=…$…`)
 *     that carries its own parameters, so `verify` needs no external config;
 *   - `verify` uses the library's password-safe comparison and *fails closed*:
 *     a malformed or foreign hash returns `false`, never a thrown raw error.
 *
 * The cost parameters are a fixed policy, not a configurable surface — a login
 * service should not be able to dial password strength down by accident.
 */

import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';

/**
 * Argon2id cost policy. These are the library's own defaults for its pinned
 * version, restated explicitly so the security posture is visible here and
 * survives any future change to that default: 19 MiB of memory, two passes,
 * single lane — the current OWASP-recommended Argon2id minimum. The algorithm
 * itself is Argon2id, which is `@node-rs/argon2`'s default when unspecified;
 * `password.test.ts` pins that by asserting the `$argon2id$` marker.
 */
const MEMORY_COST_KIB = 19_456;
const TIME_COST = 2;
const PARALLELISM = 1;

/**
 * The password-hashing seam. A future login/registration service depends on this
 * interface, never on the concrete binding, so the KDF stays swappable and the
 * service stays unit-testable.
 */
export interface PasswordHasher {
  /** Derive a storable PHC hash from a plaintext password. */
  hash(password: string): Promise<string>;
  /** True iff `password` produced `passwordHash`. Fails closed, never throws. */
  verify(passwordHash: string, password: string): Promise<boolean>;
}

async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, {
    memoryCost: MEMORY_COST_KIB,
    timeCost: TIME_COST,
    parallelism: PARALLELISM,
  });
}

async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(passwordHash, password);
  } catch {
    // A malformed / non-Argon2 stored hash makes the binding throw. Treat it as
    // a failed verification, not an error to surface: never leak why, never let
    // a bad row become a 500. The raw parse error is intentionally discarded.
    return false;
  }
}

/** The single production implementation, backed by Argon2id. */
export const argon2PasswordHasher: PasswordHasher = {
  hash: hashPassword,
  verify: verifyPassword,
};
