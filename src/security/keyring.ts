/**
 * The in-process keyring: one active encrypt key and N decrypt-only keys.
 *
 * The keyring is the *decrypt* authority for v2 envelopes (each envelope carries a
 * `kid`, and `resolve(kid)` returns its 32-byte key). Encryption is **not** a method
 * on the keyring — the active capability lives on the {@link CredentialCipher} as
 * `encryptWithActive`, which knows the kid to stamp on the envelope it produces.
 * Splitting these keeps the keyring a pure lookup table: there is no method that
 * picks "which key to encrypt with" and the active key is determined by the ring's
 * order, not by a separate flag.
 *
 * **Reserved kid — `legacy-v1`.** The literal `legacy-v1` is the authoritative key
 * identifier for v1 envelopes. It is **always decrypt-only** in the ring role:
 *
 *   1. The parser rejects a ring whose first entry is `legacy-v1` — a v1 key can
 *      never be the active key (encrypting with it would be a regression).
 *   2. The parser rejects a ring with multiple `legacy-v1` entries — at most one.
 *   3. The auto-import path (legacy env var present, new env var absent) inserts
 *      exactly one `legacy-v1` entry with role `decrypt-only`. This is the *only*
 *      auto-import path; its sole purpose is to keep an existing single-key
 *      deployment working after the Step 1 code lands.
 *
 * The ring carries no encryption primitive — the cipher uses the ring's first entry
 * (which is never `legacy-v1`) for `encryptWithActive` and the keyring's
 * `legacy-v1` entry (when present) for `decrypt` of v1 envelopes.
 */

import { CredentialKeyInvalidError } from '@/security/credential-cipher.js';
import { parseCredentialKey } from '@/security/credential-cipher.js';

/** The literal kid reserved for v1 envelopes. */
export const LEGACY_V1_KID = 'legacy-v1';

/** Regex for non-secret kid labels. */
const KID_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;

/** A single keyring entry. */
export interface KeyRingEntry {
  readonly kid: string;
  readonly key: Buffer;
  /**
   * The ring role: `active` for the first entry (encrypt + decrypt); `decrypt-only`
   * for every subsequent entry. `legacy-v1` is *never* `active`.
   */
  readonly role: 'active' | 'decrypt-only';
}

/**
 * The keyring: one active key (the first entry) and zero or more decrypt-only
 * keys (every subsequent entry). Resolves keys by kid for decryption.
 *
 * Construct via {@link KeyRing.parse} from `CREDENTIAL_ENCRYPTION_KEYS`, or via
 * {@link KeyRing.empty} for callers that need to detect the absent-keyring case.
 */
export class KeyRing {
  private readonly byKid: ReadonlyMap<string, KeyRingEntry>;

  private constructor(entries: readonly KeyRingEntry[]) {
    this.byKid = new Map(entries.map((e) => [e.kid, e]));
  }

  /**
   * Parse a `CREDENTIAL_ENCRYPTION_KEYS` value into a keyring.
   *
   * Format: comma-separated `kid:base64key` pairs. The **first** entry is active;
   * every subsequent entry is decrypt-only. `kid` must match `^[a-zA-Z0-9._-]{1,64}$`
   * and the key bytes must parse to exactly 32 bytes (same shape rule as the legacy
   * env var).
   *
   * Throws {@link CredentialKeyInvalidError} on shape errors and any violation of
   * the reserved `legacy-v1` rules — operators see a clear config error at boot.
   */
  static parse(envValue: string): KeyRing {
    const trimmed = envValue.trim();
    if (trimmed === '') {
      throw new CredentialKeyInvalidError(
        'CREDENTIAL_ENCRYPTION_KEYS must not be empty',
      );
    }
    const segments = trimmed.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (segments.length === 0) {
      throw new CredentialKeyInvalidError(
        'CREDENTIAL_ENCRYPTION_KEYS must contain at least one entry',
      );
    }
    const entries: KeyRingEntry[] = [];
    const seenKids = new Set<string>();
    segments.forEach((segment, index) => {
      const colonIdx = segment.indexOf(':');
      if (colonIdx <= 0 || colonIdx === segment.length - 1) {
        throw new CredentialKeyInvalidError(
          `CREDENTIAL_ENCRYPTION_KEYS entry ${index + 1} must be of the form "<kid>:<base64-key>"`,
        );
      }
      const kid = segment.slice(0, colonIdx);
      const keyRaw = segment.slice(colonIdx + 1);
      if (!KID_REGEX.test(kid)) {
        throw new CredentialKeyInvalidError(
          `CREDENTIAL_ENCRYPTION_KEYS entry ${index + 1}: kid "${kid}" must match ^[a-zA-Z0-9._-]{1,64}$`,
        );
      }
      if (seenKids.has(kid)) {
        throw new CredentialKeyInvalidError(
          `CREDENTIAL_ENCRYPTION_KEYS: duplicate kid "${kid}"`,
        );
      }
      seenKids.add(kid);
      const key = parseCredentialKey(keyRaw);
      entries.push({
        kid,
        key,
        role: index === 0 ? 'active' : 'decrypt-only',
      });
    });

    // Reserved-kid rule 1: legacy-v1 can never be the active (first) entry.
    if (entries[0]!.kid === LEGACY_V1_KID) {
      throw new CredentialKeyInvalidError(
        `CREDENTIAL_ENCRYPTION_KEYS: the reserved kid "${LEGACY_V1_KID}" can never be the first (active) entry`,
      );
    }
    // Reserved-kid rule 2: at most one legacy-v1 entry (duplicates already caught
    // by the seenKids check above, but the literal case is named explicitly here
    // so the error message points at the right constraint).
    const legacyCount = entries.filter((e) => e.kid === LEGACY_V1_KID).length;
    if (legacyCount > 1) {
      throw new CredentialKeyInvalidError(
        `CREDENTIAL_ENCRYPTION_KEYS: at most one "${LEGACY_V1_KID}" entry is allowed`,
      );
    }

    return new KeyRing(entries);
  }

  /**
   * Auto-import the legacy single-key deployment into a keyring with one
   * decrypt-only entry. Used by the factory when `CREDENTIAL_ENCRYPTION_KEYS` is
   * absent and the legacy `CREDENTIAL_ENCRYPTION_KEY` is present.
   */
  static fromLegacyKey(legacyKey: Buffer): KeyRing {
    return new KeyRing([
      {
        kid: LEGACY_V1_KID,
        key: legacyKey,
        role: 'decrypt-only',
      },
    ]);
  }

  /** An empty keyring — used to flag misconfiguration at use time, not at boot. */
  static empty(): KeyRing {
    return new KeyRing([]);
  }

  /** Resolve a key by kid. Throws `CredentialKeyInvalidError` on unknown kid. */
  resolve(kid: string): Buffer {
    const entry = this.byKid.get(kid);
    if (entry === undefined) {
      throw new CredentialKeyInvalidError(`unknown kid "${kid}"`);
    }
    return entry.key;
  }

  /**
   * The active kid — the kid of the first entry whose role is `active`. Returns
   * `null` when the ring is empty or when the first entry is `decrypt-only`
   * (e.g. the auto-imported single-entry `legacy-v1` ring). The first-entry-by-
   * insertion-order rule is preserved by the `byKid` map, which mirrors the
   * insertion order from `parse` and `fromLegacyKey`.
   */
  get activeKid(): string | null {
    for (const entry of this.byKid.values()) {
      if (entry.role === 'active') return entry.kid;
    }
    return null;
  }

  /** True iff this ring has an active (encrypt) entry. */
  get hasActive(): boolean {
    return this.activeKid !== null;
  }

  /** Whether this ring carries a `legacy-v1` entry — drives the cipher's v1 writer. */
  get hasLegacyV1(): boolean {
    return this.byKid.has(LEGACY_V1_KID);
  }

  /** The bytes of the `legacy-v1` entry, or null when none. */
  get legacyV1Key(): Buffer | null {
    const entry = this.byKid.get(LEGACY_V1_KID);
    return entry?.key ?? null;
  }

  /**
   * Snapshot the ring's structure (kid + role, never the key bytes) for diagnostics.
   * Operators can log this without leaking key material; the cipher logs it on boot
   * failure so a misconfigured deployment is self-describing.
   */
  describe(): readonly { readonly kid: string; readonly role: 'active' | 'decrypt-only' }[] {
    return Array.from(this.byKid.values()).map((e) => ({
      kid: e.kid,
      role: e.role,
    }));
  }
}
