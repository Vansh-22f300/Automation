/**
 * A dedicated, ephemeral secret box for the PKCE `code_verifier` at rest.
 *
 * WHY NOT THE CREDENTIAL CIPHER (state design §3). The verifier must be encrypted
 * with AAD bound to the state row, but neither credential-cipher write path fits:
 *   - `encrypt()` (v1) has no AAD at all — it cannot bind the ciphertext to the
 *     `state_hash`, so a row-swap would go undetected.
 *   - `encryptWithActive()` (v2) *requires* an active kid (absent in a
 *     legacy-only deployment) and its AAD contract is fixed to
 *     `${tenantId}:${connectionId}` — there is no connection at authorize time.
 * Forcing the verifier through either would be misuse. Instead this box is the
 * "smallest dedicated ephemeral-secret encryption helper using the existing
 * encryption primitives/key material" the requirement calls for: the SAME
 * AES-256-GCM construction and the SAME root key bytes as the credential cipher,
 * but with an HKDF-derived subkey (domain-separated) and AAD = `state_hash`.
 *
 * KEY DERIVATION. `createOAuthStateSecretBox` takes the credential cipher's active
 * key material and runs HKDF-SHA256 with a fixed salt/info label to produce a
 * 32-byte subkey. Domain separation means this subkey is cryptographically
 * independent of the credential key — a compromise of one does not read the
 * other, yet operators manage a single key.
 *
 * ROTATION TOLERANCE. The subkey follows the active credential key; rotating that
 * key changes the subkey and makes previously-sealed verifiers un-openable. That
 * is acceptable and intended: `oauth_states` rows live for minutes, so at worst a
 * key rotation invalidates the handful of in-flight flows, which simply restart.
 *
 * The box never logs the verifier, the key, the tag, or a cause object.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { PermanentError } from '@/domain/errors.js';
import type { CredentialCipher } from '@/security/credential-cipher.js';
import { LEGACY_V1_KID } from '@/security/keyring.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SUBKEY_BYTES = 32;
/** Fixed, non-secret HKDF context — the only thing separating this key from the credential key. */
const HKDF_SALT = Buffer.from('ai-workforce/oauth-state/hkdf-salt/v1', 'utf8');
const HKDF_INFO = Buffer.from('ai-workforce/oauth-state/code-verifier/v1', 'utf8');

/** The persisted shape of a sealed verifier (stored as jsonb). Every field but `v`/`alg` is base64. */
export interface OAuthSecretEnvelope {
  readonly v: 1;
  readonly alg: 'aes-256-gcm';
  readonly iv: string;
  readonly ct: string;
  readonly tag: string;
}

/** Raised on any seal/open failure. Deterministic; never carries key or ciphertext in its message. */
export class OAuthStateSecretError extends PermanentError {
  constructor(message: string, cause?: unknown) {
    super('oauth_state_secret_failed', message, cause !== undefined ? { cause } : undefined);
  }
}

/**
 * AES-256-GCM sealing of a single short secret (the PKCE verifier), authenticated
 * against a caller-supplied AAD (the row's `state_hash`).
 */
export class OAuthStateSecretBox {
  private readonly key: Buffer;

  constructor(rootKey: Buffer) {
    this.key = Buffer.from(hkdfSync('sha256', rootKey, HKDF_SALT, HKDF_INFO, SUBKEY_BYTES));
  }

  /** Seal `plaintext`, binding the ciphertext to `aad` via the GCM tag. */
  seal(plaintext: string, aad: string): OAuthSecretEnvelope {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      v: 1,
      alg: ALGORITHM,
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: tag.toString('base64'),
    };
  }

  /**
   * Open an envelope, verifying the GCM tag over the same `aad`. A tampered blob,
   * the wrong key, or a mismatched AAD throws {@link OAuthStateSecretError} rather
   * than returning forged plaintext.
   */
  open(envelope: OAuthSecretEnvelope, aad: string): string {
    if (envelope.v !== 1 || envelope.alg !== ALGORITHM) {
      throw new OAuthStateSecretError('unsupported oauth-state secret envelope');
    }
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const ct = Buffer.from(envelope.ct, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new OAuthStateSecretError('oauth-state secret envelope has a malformed iv or tag');
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(tag);
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch (error) {
      throw new OAuthStateSecretError(
        'failed to open oauth-state secret (bad key, aad, or tampered data)',
        error,
      );
    }
  }
}

/**
 * Build the box from the credential cipher's key material. Boot guarantees the
 * ring carries at least one key, so the active kid (or the reserved `legacy-v1`
 * kid) always resolves.
 */
export function createOAuthStateSecretBox(cipher: CredentialCipher): OAuthStateSecretBox {
  const kid = cipher.ring.activeKid ?? LEGACY_V1_KID;
  const rootKey = cipher.ring.resolve(kid);
  return new OAuthStateSecretBox(rootKey);
}
