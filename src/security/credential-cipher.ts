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
 * The persisted representation is a small **versioned envelope** (`v`, `alg`, `iv`,
 * `ct`, `tag`), so a future key-rotation/versioning scheme can add `v: 2` and a key
 * id without a data migration. Step 9A does not implement rotation; it only makes it
 * possible. The plaintext that gets encrypted is the caller's credential object as
 * JSON — it deliberately does NOT embed the tenant id or provider (those live in
 * the row, unencrypted, and putting them in the secret would only weaken the
 * separation between "what identifies the row" and "the secret itself").
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { Env } from '@/config/env.js';
import { PermanentError } from '@/domain/errors.js';

/** The AEAD algorithm. A constant so the envelope is self-describing and checkable. */
const ALGORITHM = 'aes-256-gcm';
/** 96-bit IV — the size AES-GCM is defined and fastest for. Random, never reused. */
const IV_BYTES = 12;
/** 128-bit authentication tag. */
const TAG_BYTES = 16;
/** AES-256 needs exactly 32 bytes of key. */
const KEY_BYTES = 32;
/** The only envelope version this module writes and reads today. */
const ENVELOPE_VERSION = 1;

/**
 * The stored shape of an encrypted credential. Persisted as `jsonb`. Every field
 * except `v`/`alg` is base64. `v` exists so a later version can be distinguished
 * and migrated; `alg` makes the blob self-describing rather than relying on a
 * convention no future reader can see.
 */
export interface EncryptedEnvelope {
  readonly v: number;
  readonly alg: string;
  /** base64 initialisation vector (nonce). */
  readonly iv: string;
  /** base64 ciphertext. */
  readonly ct: string;
  /** base64 GCM authentication tag. */
  readonly tag: string;
}

/** A credential object is any JSON-serialisable record. Its contents are opaque here. */
export type CredentialPayload = Record<string, unknown>;

/** Raised when a key is needed but none is configured. Deterministic — not retryable. */
export class CredentialKeyMissingError extends PermanentError {
  constructor() {
    super(
      'credential_key_missing',
      'a credential encryption operation was attempted but CREDENTIAL_ENCRYPTION_KEY is not configured',
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
 * Raised when decryption fails: a tampered blob, a truncated tag, the wrong key, or
 * an unrecognised envelope. Never carries the ciphertext or key in its message.
 */
export class CredentialDecryptionError extends PermanentError {
  constructor(message: string, cause?: unknown) {
    super('credential_decryption_failed', message, cause !== undefined ? { cause } : undefined);
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
 * Holds an optional key: metadata-only operations (listing connections) need no key,
 * so a repository can be constructed without one and only the encrypt/decrypt paths
 * demand it — failing clearly via {@link CredentialKeyMissingError} when it is
 * absent. The key never leaves this object and is never logged.
 */
export class CredentialCipher {
  constructor(private readonly key: Buffer | null) {}

  /** Whether a key is present — lets callers surface a clear setup error early. */
  get hasKey(): boolean {
    return this.key !== null;
  }

  private requireKey(): Buffer {
    if (this.key === null) throw new CredentialKeyMissingError();
    return this.key;
  }

  /** Encrypt a credential object into a versioned, authenticated envelope. */
  encrypt(payload: CredentialPayload): EncryptedEnvelope {
    const key = this.requireKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      v: ENVELOPE_VERSION,
      alg: ALGORITHM,
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
   */
  decrypt(envelope: EncryptedEnvelope): CredentialPayload {
    const key = this.requireKey();

    if (envelope.v !== ENVELOPE_VERSION || envelope.alg !== ALGORITHM) {
      throw new CredentialDecryptionError(
        `unsupported credential envelope (version ${envelope.v}, algorithm ${envelope.alg})`,
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
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as CredentialPayload;
    } catch (error) {
      // Authentication failure, wrong key, or corrupt data — never distinguish, and
      // never leak the cause's contents to callers.
      throw new CredentialDecryptionError('failed to decrypt credential (bad key or tampered data)', error);
    }
  }
}

/**
 * Build a cipher from validated environment config. When `CREDENTIAL_ENCRYPTION_KEY`
 * is unset the cipher has no key and any encrypt/decrypt call fails clearly — which
 * is why the application still boots without it (nothing constructs a credential
 * until a connection operation actually needs one).
 */
export function createCredentialCipher(env: Env): CredentialCipher {
  const raw = env.CREDENTIAL_ENCRYPTION_KEY;
  return new CredentialCipher(raw !== undefined ? parseCredentialKey(raw) : null);
}
