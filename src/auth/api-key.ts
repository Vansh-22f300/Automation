/**
 * API-key cryptography — generation, hashing, parsing, verification.
 *
 * All the security-sensitive primitives live here, isolated from storage and
 * from HTTP so they can be reasoned about and unit-tested on their own. The
 * invariants this module is responsible for:
 *
 * - Keys are 256 bits of CSPRNG output (`randomBytes`), so they are infeasible
 *   to guess and there is nothing to brute-force.
 * - Only a SHA-256 *hash* of the secret ever leaves this module for storage. The
 *   plaintext is returned exactly once, at creation, and never persisted.
 * - Verification compares hashes with `timingSafeEqual`, so a caller cannot learn
 *   the stored hash byte-by-byte from response timing.
 *
 * Why SHA-256 and not bcrypt/argon2: those exist to make *low-entropy* human
 * passwords slow to brute-force. An API key is high-entropy random, so there is
 * no dictionary to run and a deliberately slow hash would only add latency to
 * every authenticated request. A fast cryptographic hash is the right tool.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Human-visible marker on every key. Lets a leaked key be recognised in logs or
 * a code search ("what is this `awk_…` string?") and lets us reject obviously
 * foreign tokens before doing any work.
 */
export const API_KEY_PREFIX = 'awk_';

/** 32 bytes = 256 bits of entropy. */
const SECRET_BYTES = 32;

/**
 * How many leading characters of the secret become the stored, non-secret
 * `prefix`. 12 base64url chars ≈ 72 bits — far more than enough to be unique
 * across any realistic number of keys, so the prefix lookup resolves a single
 * row. It is not itself a secret; it only identifies which key is being tried.
 */
const PREFIX_LENGTH = 12;

/** The material stored for a key. The plaintext is NOT here — see `GeneratedApiKey`. */
export interface ApiKeyMaterial {
  /** Non-secret identifier: the first `PREFIX_LENGTH` chars of the secret. */
  readonly prefix: string;
  /** SHA-256 of the secret, hex-encoded. Safe to persist. */
  readonly keyHash: string;
}

/** The result of minting a key: storable material plus the one-time plaintext. */
export interface GeneratedApiKey extends ApiKeyMaterial {
  /**
   * The full key to hand to the caller — the ONLY time it exists in plaintext.
   * It is never stored and never logged.
   */
  readonly plaintext: string;
}

/** SHA-256 of a secret, hex-encoded. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Mint a new API key. Returns the storable material and the one-time plaintext.
 * The caller persists `{ prefix, keyHash }` and shows `plaintext` to the user
 * once.
 */
export function generateApiKey(): GeneratedApiKey {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return {
    plaintext: API_KEY_PREFIX + secret,
    prefix: secret.slice(0, PREFIX_LENGTH),
    keyHash: hashSecret(secret),
  };
}

/** A well-formed presented key, split into the parts authentication needs. */
export interface ParsedApiKey {
  /** The secret portion (everything after the marker). */
  readonly secret: string;
  /** The prefix to look a candidate row up by. */
  readonly prefix: string;
}

/**
 * Structurally validate a presented key without touching storage. Returns null
 * for anything that could not possibly be one of ours, so obviously malformed
 * input is rejected as 401 before a database lookup.
 */
export function parseApiKey(plaintext: string): ParsedApiKey | null {
  if (!plaintext.startsWith(API_KEY_PREFIX)) return null;

  const secret = plaintext.slice(API_KEY_PREFIX.length);
  // Must be at least a full prefix long, and only base64url characters.
  if (secret.length < PREFIX_LENGTH) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(secret)) return null;

  return { secret, prefix: secret.slice(0, PREFIX_LENGTH) };
}

/**
 * Constant-time check that `presentedSecret` hashes to `storedHash`.
 *
 * Both sides are reduced to a fixed 32-byte SHA-256 digest first, so the lengths
 * always match and `timingSafeEqual` never throws — and, more importantly, the
 * comparison time does not depend on how many leading bytes happen to match.
 */
export function verifySecret(presentedSecret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashSecret(presentedSecret), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHash, 'hex');
  } catch {
    return false;
  }
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}
