/**
 * Credential encryption — application-level authenticated encryption at rest.
 *
 * External-service credentials (API tokens, OAuth refresh tokens, passwords) are
 * secrets. They must never sit in PostgreSQL as plaintext, and reversible encoding
 * (base64, "obfuscation") is not encryption. This module is the single authority on
 * how a credential object becomes a stored blob and back.
 *
 * The construction is **AES-256-GCM**, an AEAD cipher from Node's standard `crypto`
 * (no bespoke cryptography):
 *
 *   - a fresh random 96-bit IV per encryption, so encrypting the same secret twice
 *     yields different ciphertext and nonces never repeat under one key;
 *   - a 128-bit authentication tag, **verified before** any plaintext is returned,
 *     so a tampered or truncated blob fails loudly instead of decrypting to garbage;
 *   - a 256-bit key supplied only through environment configuration — never stored
 *     in the database, never logged, never returned by the API.
 *
 * The persisted representation is a **versioned envelope**. Two versions coexist:
 *
 *   - **v1** (`{v, alg, iv, ct, tag}`): the original shape. No `kid`, no AAD.
 *     Still the default write shape so an existing single-key deployment keeps
 *     producing byte-identical envelopes after upgrade.
 *   - **v2** (`{v, alg, kid, iv, ct, tag}`): adds `kid` (so the keyring can resolve
 *     the key) and an AAD binding of `${tenantId}:${connectionId}` that ties the
 *     ciphertext to its row cryptographically. v2 is written **only** by the
 *     `connections:rotate` operator action — `connections:create` continues to emit
 *     v1 envelopes until an operator opts in to v2 writes (deliberate, deferred).
 *
 * Two parallel capabilities back the cipher:
 *
 *   - **legacyV1Writer** — the bytes that produce v1 envelopes. Set from either
 *     the legacy env var (`CREDENTIAL_ENCRYPTION_KEY`) or the keyring's
 *     `legacy-v1` entry. Null means `encrypt()` throws `legacy_v1_writer_missing`.
 *   - **ring** — the keyring carrying zero-or-more keys, the first of which is the
 *     **v2 active key**. Null active means `encryptWithActive()` throws
 *     `active_key_missing`. Encryption via the ring goes through the cipher (so AAD
 *     is applied) — the keyring itself has no encrypt method.
 *
 * The cipher never logs plaintext, key material, the auth tag, or the cause object
 * of any thrown error. The never-log list is enforced by the existing tests.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { Env } from '@/config/env.js';
import { LEGACY_V1_KID, KeyRing } from '@/security/keyring.js';
import { PermanentError } from '@/domain/errors.js';

/** The AEAD algorithm. A constant so the envelope is self-describing and checkable. */
const ALGORITHM = 'aes-256-gcm';
/** 96-bit IV — the size AES-GCM is defined and fastest for. Random, never reused. */
const IV_BYTES = 12;
/** 128-bit authentication tag. */
const TAG_BYTES = 16;
/** AES-256 needs exactly 32 bytes of key. */
const KEY_BYTES = 32;
/** Envelope version constants. */
const ENVELOPE_VERSION_V1 = 1;
const ENVELOPE_VERSION_V2 = 2;

/**
 * The v1 envelope (unchanged shape). Still written by `encrypt()` and read by
 * `decrypt()` for every pre-v2 row. No AAD; the legacy key in the ring resolves
 * the bytes; tampered or wrong-keyed ciphertext fails GCM verification with no
 * plaintext returned.
 */
export interface EncryptedEnvelopeV1 {
  readonly v: 1;
  readonly alg: 'aes-256-gcm';
  /** base64 initialisation vector (nonce). */
  readonly iv: string;
  /** base64 ciphertext. */
  readonly ct: string;
  /** base64 GCM authentication tag. */
  readonly tag: string;
}

/**
 * The v2 envelope. Adds `kid` (the keyring entry that produced it) and the AAD
 * binding of `${tenantId}:${connectionId}` (see {@link decrypt}). v2 envelopes are
 * written only by `encryptWithActive()` — `encrypt()` continues to emit v1.
 */
export interface EncryptedEnvelopeV2 {
  readonly v: 2;
  readonly alg: 'aes-256-gcm';
  /** Non-secret kid label, `^[a-zA-Z0-9._-]{1,64}$`. */
  readonly kid: string;
  /** base64 initialisation vector (nonce). */
  readonly iv: string;
  /** base64 ciphertext. */
  readonly ct: string;
  /** base64 GCM authentication tag. */
  readonly tag: string;
}

/**
 * The stored shape of an encrypted credential: a discriminated union on `v`.
 * Persisted as `jsonb`. Every field except `v`/`alg`/`kid` is base64.
 */
export type EncryptedEnvelope = EncryptedEnvelopeV1 | EncryptedEnvelopeV2;

/** A credential object is any JSON-serialisable record. Its contents are opaque here. */
export type CredentialPayload = Record<string, unknown>;

/** Raised when a key is needed but none is configured. Deterministic — not retryable. */
export class CredentialKeyMissingError extends PermanentError {
  constructor() {
    super(
      'credential_key_missing',
      'a credential encryption operation was attempted but no key is configured',
    );
  }
}

/** Raised when a key value is present but malformed (wrong length/encoding). */
export class CredentialKeyInvalidError extends PermanentError {
  constructor(message: string) {
    super('credential_key_invalid', message);
  }
}

/**
 * Raised when decryption fails: a tampered blob, a truncated tag, the wrong key, an
 * unrecognised envelope, a missing `legacy-v1` ring entry, or an unknown kid.
 * Never carries the ciphertext or key in its message.
 */
export class CredentialDecryptionError extends PermanentError {
  constructor(message: string, cause?: unknown) {
    super('credential_decryption_failed', message, cause !== undefined ? { cause } : undefined);
  }
}

/** Raised when `encrypt()` is called with no v1 writer configured. */
export class CredentialLegacyV1WriterMissingError extends PermanentError {
  constructor() {
    super(
      'credential_legacy_v1_writer_missing',
      'a v1 credential write was attempted but no v1 writer is configured ' +
        '(set CREDENTIAL_ENCRYPTION_KEY or include a "legacy-v1" entry in CREDENTIAL_ENCRYPTION_KEYS)',
    );
  }
}

/** Raised when `encryptWithActive()` is called with no v2 active key configured. */
export class CredentialActiveKeyMissingError extends PermanentError {
  constructor() {
    super(
      'credential_active_key_missing',
      'a v2 credential write was attempted but CREDENTIAL_ENCRYPTION_KEYS has no active entry',
    );
  }
}

/**
 * Parse a configured key string into 32 raw bytes.
 *
 * Accepts either 64 hex characters or base64/base64url that decodes to exactly 32
 * bytes. Anything else is rejected with a message that describes the shape problem
 * without echoing the value (it is a secret and this runs at config time).
 */
export function parseCredentialKey(raw: string): Buffer {
  const trimmed = raw.trim();

  // Hex: exactly 64 hex chars → 32 bytes.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  // Otherwise treat as base64 / base64url. Buffer.from is lenient, so verify the
  // decoded length rather than trusting the input to be well-formed.
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === KEY_BYTES) {
    return decoded;
  }

  throw new CredentialKeyInvalidError(
    `must decode to ${KEY_BYTES} bytes (256 bits): supply 64 hex characters or a base64 value of a 32-byte key`,
  );
}

/** Generate a fresh 256-bit key as base64. For local/dev key creation and tests only. */
export function generateCredentialKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/**
 * Authenticated encryption of credential objects.
 *
 * Holds two parallel capabilities: a {@link KeyRing} (decrypt authority, with the
 * first entry as the v2 active key) and a `legacyV1Writer` Buffer (the bytes that
 * produce v1 envelopes — either the legacy env var or the keyring's `legacy-v1`
 * entry). The cipher exposes three operations:
 *
 *   - `encrypt(payload)` — writes **v1** envelopes using `legacyV1Writer`. Throws
 *     `CredentialLegacyV1WriterMissingError` when the writer is null. This is the
 *     default write path; `connections:create` calls it.
 *   - `encryptWithActive(payload, aad)` — writes **v2** envelopes using the
 *     keyring's active kid and the supplied AAD. Throws
 *     `CredentialActiveKeyMissingError` when the ring has no active entry. Used
 *     only by `connections:rotate`.
 *   - `decrypt(envelope, aad?, tenantId?, connectionId?)` — dispatches on
 *     `envelope.v`: v1 uses `ring.resolve("legacy-v1")` and skips `setAAD`; v2 uses
 *     `ring.resolve(envelope.kid)` and calls `setAAD` with the tenant/connection
 *     binding. Every failure mode collapses to `CredentialDecryptionError` with a
 *     generic message — no key bytes, ciphertext or cause object leaks to callers.
 *
 * `hasKey` reports whether **any** write capability is configured (legacy writer OR
 * v2 active key), preserving the smoke-test guards that check before attempting to
 * decrypt.
 */
export class CredentialCipher {
  constructor(
    private readonly legacyV1Writer: Buffer | null,
    private readonly ring_: KeyRing,
  ) {}

  /**
   * Whether the cipher has at least one write capability. True when either the v1
   * writer is set or the ring carries an active key. Preserves the smoke-test
   * "no key ⇒ cannot decrypt ⇒ cannot run the live path" semantics.
   */
  get hasKey(): boolean {
    return this.legacyV1Writer !== null || this.ring_.hasActive;
  }

  /**
   * The keyring this cipher is bound to. Exposed so the rotation CLI can read
   * the active kid for the iteration predicate. The cipher still owns all
   * encrypt/decrypt operations through it.
   */
  get ring(): KeyRing {
    return this.ring_;
  }

  /**
   * Encrypt a credential object into a **v1** envelope (byte-identical to the
   * pre-v2 envelope). Backs `connections:create` and preserves the rolling-deploy
   * compatibility release: an existing single-key deployment continues to write
   * the same envelope shape after upgrade.
   */
  encrypt(payload: CredentialPayload): EncryptedEnvelopeV1 {
    if (this.legacyV1Writer === null) {
      throw new CredentialLegacyV1WriterMissingError();
    }
    const key = this.legacyV1Writer;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      v: ENVELOPE_VERSION_V1,
      alg: ALGORITHM,
      iv: iv.toString('base64'),
      ct: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    };
  }

  /**
   * Encrypt a credential object into a **v2** envelope using the keyring's active
   * kid and the supplied AAD. Used only by `connections:rotate`; an operator-initiated
   * action that re-encrypts every ciphertext under the current active key.
   *
   * The `aad` binds the ciphertext to `${tenantId}:${connectionId}` so a row-swap
   * fails GCM verification on the next read. The AAD is a 73-byte UTF-8 buffer for
   * two UUIDv7 strings plus the colon — the caller passes exactly that.
   */
  encryptWithActive(payload: CredentialPayload, aad: Buffer): EncryptedEnvelopeV2 {
    const activeKid = this.ring_.activeKid;
    if (activeKid === null) {
      throw new CredentialActiveKeyMissingError();
    }
    const key = this.ring_.resolve(activeKid);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(aad);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      v: ENVELOPE_VERSION_V2,
      alg: ALGORITHM,
      kid: activeKid,
      iv: iv.toString('base64'),
      ct: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
    };
  }

  /**
   * Decrypt an envelope back into the credential object. The GCM tag is verified as
   * part of `final()`, so a tampered blob or the wrong key throws rather than
   * yielding forged plaintext. All failure modes collapse to
   * {@link CredentialDecryptionError} with a generic message.
   *
   * For v2 envelopes the caller passes `tenantId` and `connectionId` so the cipher
   * can reconstruct the `${tenantId}:${connectionId}` AAD. For v1 envelopes these
   * arguments are ignored — v1 predates AAD and uses the legacy key directly.
   */
  decrypt(
    envelope: EncryptedEnvelope,
    options: { readonly aad?: Buffer; readonly tenantId?: string; readonly connectionId?: string } = {},
  ): CredentialPayload {
    if (envelope.v === ENVELOPE_VERSION_V1) {
      return this.decryptV1(envelope);
    }
    if (envelope.v === ENVELOPE_VERSION_V2) {
      return this.decryptV2(envelope, options);
    }
    throw new CredentialDecryptionError(
      `unsupported credential envelope (version ${(envelope as { v: unknown }).v as string})`,
    );
  }

  private decryptV1(envelope: EncryptedEnvelopeV1): CredentialPayload {
    let key: Buffer;
    try {
      key = this.ring_.resolve(LEGACY_V1_KID);
    } catch {
      throw new CredentialDecryptionError(
        'failed to decrypt credential (legacy_v1_key_missing)',
      );
    }

    if (envelope.alg !== ALGORITHM) {
      throw new CredentialDecryptionError(
        `unsupported credential envelope (algorithm ${envelope.alg})`,
      );
    }

    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const ciphertext = Buffer.from(envelope.ct, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new CredentialDecryptionError('credential envelope has a malformed iv or tag');
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      // No setAAD for v1 — v1 envelopes predate AAD.
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as CredentialPayload;
    } catch (error) {
      throw new CredentialDecryptionError('failed to decrypt credential (bad key or tampered data)', error);
    }
  }

  private decryptV2(
    envelope: EncryptedEnvelopeV2,
    options: { readonly aad?: Buffer; readonly tenantId?: string; readonly connectionId?: string },
  ): CredentialPayload {
    if (envelope.alg !== ALGORITHM) {
      throw new CredentialDecryptionError(
        `unsupported credential envelope (algorithm ${envelope.alg})`,
      );
    }
    if (typeof envelope.kid !== 'string' || envelope.kid.length === 0) {
      throw new CredentialDecryptionError('credential envelope is missing a kid');
    }

    let key: Buffer;
    try {
      key = this.ring_.resolve(envelope.kid);
    } catch {
      throw new CredentialDecryptionError(
        `failed to decrypt credential (unknown_kid "${envelope.kid}")`,
      );
    }

    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const ciphertext = Buffer.from(envelope.ct, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new CredentialDecryptionError('credential envelope has a malformed iv or tag');
    }

    // AAD reconstruction. The caller passes either a pre-built buffer or the
    // (tenantId, connectionId) pair; either way the GCM tag verification covers
    // exactly the same bytes that were passed at encrypt time, otherwise the tag
    // fails and the ciphertext is refused.
    const aad = options.aad ?? this.deriveAad(options.tenantId, options.connectionId);

    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      if (aad !== undefined) decipher.setAAD(aad);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as CredentialPayload;
    } catch (error) {
      throw new CredentialDecryptionError('failed to decrypt credential (bad key or tampered data)', error);
    }
  }

  /**
   * Reconstruct the `${tenantId}:${connectionId}` AAD from the two id strings.
   * Both UUIDv7 strings are 36 chars; the total AAD is 73 bytes. Returning
   * `undefined` when either input is missing is intentional — a v2 read without a
   * caller-supplied AAD (or id pair) cannot validate the tag against the row that
   * produced it, so we leave it out and rely on the GCM tag failing when the
   * AAD-free path is taken on a row that was written WITH AAD.
   */
  private deriveAad(tenantId?: string, connectionId?: string): Buffer | undefined {
    if (tenantId === undefined || connectionId === undefined) return undefined;
    return Buffer.from(`${tenantId}:${connectionId}`, 'utf8');
  }
}

/**
 * Build a cipher from validated environment config.
 *
 * - The {@link KeyRing} is built from `CREDENTIAL_ENCRYPTION_KEYS` when present.
 *   When absent but `CREDENTIAL_ENCRYPTION_KEY` is set, the legacy key is auto-
 *   imported as a single decrypt-only `legacy-v1` entry. When both are absent, the
 *   ring is empty (use-time failures surface typed errors).
 * - `legacyV1Writer` is set from the legacy env var when present, OR from the
 *   ring's `legacy-v1` entry when the new var was set without one (the
 *   "keyring-first" deployment). Null when neither source provides it (the
 *   "keyring without legacy" deployment), and `encrypt()` fails at first use.
 *
 * See the env × behaviour matrix in §7 of the architectural plan for the exact
 * contract this factory implements.
 */
export function createCredentialCipher(env: Env): CredentialCipher {
  const legacyRaw = env.CREDENTIAL_ENCRYPTION_KEY;
  const newRaw = env.CREDENTIAL_ENCRYPTION_KEYS;
  const legacyKey = legacyRaw !== undefined ? parseCredentialKey(legacyRaw) : null;

  // Build the ring: explicit new var > auto-import of legacy > empty.
  let ring: KeyRing;
  if (newRaw !== undefined) {
    ring = KeyRing.parse(newRaw);
  } else if (legacyKey !== null) {
    ring = KeyRing.fromLegacyKey(legacyKey);
  } else {
    ring = KeyRing.empty();
  }

  // Build the legacyV1Writer: keyring's legacy-v1 entry wins over the legacy
  // env var. The §7 matrix row "present / present, keyring contains legacy-v1"
  // is explicit: when both sources exist, the keyring's bytes are authoritative
  // for the v1 writer. The legacy env var only acts as a backstop when the
  // keyring lacks a legacy-v1 entry — that is the "keyring-first deployment
  // keeps create working" case.
  let legacyV1Writer: Buffer | null;
  if (ring.hasLegacyV1) {
    legacyV1Writer = ring.legacyV1Key;
  } else if (legacyKey !== null) {
    legacyV1Writer = legacyKey;
  } else {
    legacyV1Writer = null;
  }

  return new CredentialCipher(legacyV1Writer, ring);
}
