/**
 * Webhook signature verification — provider-neutral HMAC with explicit signed-input semantics.
 *
 * The whole point of webhook signature verification is to bind an incoming delivery to
 * (a) the secret shared with the provider and (b) the exact bytes the provider signed.
 * Any verification that does not do both is not a signature check; it is a hash check
 * that an attacker can re-submit freely.
 *
 * Two signed-input modes are supported and named in configuration so that a verifier
 * cannot accept the wrong bytes by accident:
 *
 *   - `raw_body`            — HMAC-SHA256(key, rawBody)
 *   - `timestamp_and_body`  — HMAC-SHA256(key, canonicalTimestamp || 0x2E || rawBody)
 *
 * The separator is a single literal byte (`0x2E`, ".") and is part of the design —
 * it is not configurable, so no provider's scheme can be expressed by re-pointing the
 * separator at something a captured signature was actually over. Adding new schemes is
 * a code change with a new mode, not a config knob, so an operator cannot author a
 * signing config that the verifier cannot justify.
 *
 * **`timestamp_and_body` mode provides:**
 *
 *   - **Authenticated timestamp** — the timestamp is in the HMAC input. An attacker
 *     cannot substitute a fresh timestamp without invalidating the signature.
 *   - **Freshness / tolerance enforcement** — the parsed integer is checked against
 *     `tolerance_seconds` of the verifier's clock; stale and far-future timestamps
 *     are rejected as `timestamp_out_of_tolerance`.
 *   - **Replay-window protection** — an attacker cannot replay a captured valid
 *     delivery outside the configured tolerance window. Within the window, an
 *     exact duplicate delivery with the same `(timestamp, body, signature)` is NOT
 *     rejected by this verifier; the existing webhook `X-Event-ID` dedupe is a
 *     separate, caller-controlled layer that may suppress such duplicates. This
 *     module does not, on its own, provide universal one-time replay prevention.
 *
 * **Timestamp canonicalization:** `parseTimestamp` returns the canonical text
 * `String(n)` (after whitespace trim and decimal-digit validation). Leading zeros
 * in the header are stripped; whitespace is removed; any other shape (`+`, `-`,
 * `.`, hex, internal whitespace, etc.) is rejected as `timestamp_malformed`. The
 * signed bytes are computed over the canonical text only — a sender who signs the
 * literal header value with leading zeros or internal whitespace will see their
 * signature rejected as `signature_mismatch`.
 *
 * This module is pure: no I/O, no framework. The route layer reads the parsed config
 * and the secret, calls {@link verifyWebhookSignature}, and translates failures into an
 * HTTP response. No raw body, signature, or secret ever leaves this layer in a log
 * line: the only thing surfaced to logs is a non-secret reason code plus the lengths
 * of the inputs (lengths cannot reconstruct the secret or the body).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Header names are HTTP token-safe: letters, digits, `-`. The same character set HTTP
 * allows in field-name tokens. Lowercase accepted because Node lowercases incoming
 * header names; lowercase enforced on the way in so no casing drift can hide the wrong
 * header.
 */
const HEADER_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;
const headerNameSchema = z
  .string()
  .regex(HEADER_NAME_PATTERN, 'must be 1-64 lowercase letters/digits/hyphens');

const uuidSchema = z.string().uuid();

/**
 * `signature_prefix` is the optional literal that the sender prepends to the
 * signature value (e.g. `sha256=`). It is matched and stripped exactly; an empty
 * string is the same as omitting it. Bounded length so a misconfiguration cannot
 * sink auth.
 *
 * Accepted characters are the printable-ASCII range (0x21..0x7E), which excludes
 * whitespace and DEL. This covers letters, digits, and the common scheme markers
 * (`=`, `,`, `-`, `_`, `:`, etc.) used by providers like GitHub (`sha256=`) and
 * Stripe (`t=,v1=`).
 */
const signaturePrefixSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => v === v.trim() && /^[\x21-\x7E]+$/.test(v), {
    message: 'must be printable ASCII, no whitespace',
  });

/**
 * The base `signature` config that every mode requires.
 *
 * `algorithm` is constrained to a literal `hmac-sha256` because the verifier is a
 * single algorithm and an operator cannot author a config that names anything else.
 * `signature_encoding` is constrained to `hex` or `base64` for the same reason:
 * no arbitrary encoding, no ambiguity, no room for a `none`/empty misconfiguration.
 */
const baseSignatureFields = {
  algorithm: z.literal('hmac-sha256'),
  secret_connection_id: uuidSchema,
  signature_header: headerNameSchema,
  signature_encoding: z.enum(['hex', 'base64']),
  signature_prefix: signaturePrefixSchema.optional(),
} as const;

/**
 * The `raw_body` variant: HMAC-SHA256(key, rawBody). This is the simple mode.
 *
 * The verifier is exactly equivalent to:
 *
 *     HMAC-SHA256(key=secret, msg=rawBody)
 *
 * And the request header (after `signature_prefix` is stripped, if configured) is the
 * HMAC encoded as `signature_encoding`. No timestamp, no separator, no other bytes.
 */
const rawBodyConfigSchema = z
  .object({
    signing_input: z.literal('raw_body'),
    ...baseSignatureFields,
  })
  .strict();

/**
 * The `timestamp_and_body` variant. The signed bytes are:
 *
 *     <decimal_seconds> || 0x2E || rawBody
 *
 * where `<decimal_seconds>` is the integer value of the timestamp header formatted as
 * an unsigned decimal (`String(n)`), and `0x2E` is a single `.` byte. The verifier
 * parses the timestamp header as a decimal integer, checks it against the current
 * time with `tolerance_seconds` slack, and only then computes HMAC.
 *
 * `tolerance_seconds` is bounded (1..3600) so a misconfiguration cannot quietly
 * disable the check (lower bound) or accept hours-old requests (upper bound).
 */
const timestampAndBodyConfigSchema = z
  .object({
    signing_input: z.literal('timestamp_and_body'),
    ...baseSignatureFields,
    timestamp_header: headerNameSchema,
    tolerance_seconds: z
      .number()
      .int()
      .min(1, 'must be at least 1 second')
      .max(3600, 'must not exceed 3600 seconds (1 hour)'),
  })
  .strict();

/**
 * The discriminator is `signing_input` so the schema narrows correctly at the type
 * level. `.strict()` rejects unknown fields, so a misspelled or non-supported field
 * fails at parse time rather than silently being ignored.
 */
export const webhookSignatureConfigSchema = z.discriminatedUnion('signing_input', [
  rawBodyConfigSchema,
  timestampAndBodyConfigSchema,
]);

export type WebhookSignatureConfig = z.infer<typeof webhookSignatureConfigSchema>;
export type RawBodySignatureConfig = z.infer<typeof rawBodyConfigSchema>;
export type TimestampAndBodySignatureConfig = z.infer<typeof timestampAndBodyConfigSchema>;

/**
 * Parse an unknown value as a {@link WebhookSignatureConfig}. Throws `ZodError` on
 * failure — the boundary between stored JSON and trusted config is the Zod parse, and
 * an invalid stored shape is treated as an explicit failure.
 */
export function parseWebhookSignatureConfig(input: unknown): WebhookSignatureConfig {
  return webhookSignatureConfigSchema.parse(input);
}

/**
 * Distinct reason codes a verifier failure can produce. Stable strings so callers
 * (route handler, structured logs, tests) can match on them without parsing message
 * text. None of the codes itself discloses whether a signature would have matched.
 */
export type SignatureFailureReason =
  /** Required signature header is absent. */
  | 'signature_header_missing'
  /** Signature value does not decode per `signature_encoding`, or is the wrong length. */
  | 'signature_malformed'
  /** `timestamp_and_body` mode: timestamp header is absent. */
  | 'timestamp_header_missing'
  /** `timestamp_and_body` mode: timestamp header is not a decimal integer. */
  | 'timestamp_malformed'
  /**
   * `timestamp_and_body` mode: timestamp is parsed but is more than
   * `tolerance_seconds` away from the verifier's clock in either direction.
   */
  | 'timestamp_out_of_tolerance'
  /** HMAC comparison failed (in constant time). */
  | 'signature_mismatch';

/** Outcome of a verification call. */
export type VerifyResult =
  | { readonly outcome: 'valid' }
  | { readonly outcome: 'invalid'; readonly reason: SignatureFailureReason };

/** Read-only access to the headers relevant to a webhook signature check. */
export interface WebhookHeaders {
  /** Lowercased HTTP header name → first header value, or undefined if not sent. */
  get(name: string): string | undefined;
}

/**
 * Inputs the verifier needs. The raw body must be the exact, untouched bytes
 * captured before JSON parsing; re-serialising the parsed object will not reproduce
 * the same bytes and will invalidate the signature.
 *
 * `now` is injected so tests can pin time deterministically. The route layer passes
 * `new Date()`.
 */
export interface VerifyInput {
  readonly rawBody: Buffer;
  readonly headers: WebhookHeaders;
  readonly now: Date;
}

/**
 * The HMAC algorithm constant. Internal because the Zod schema enforces the literal
 * `'hmac-sha256'` — we never accept a runtime-selected algorithm.
 */
const HMAC_ALGORITHM = 'sha256';

/** Separator between timestamp and body in `timestamp_and_body` mode: a single `.`. */
const SIGNED_INPUT_SEPARATOR = 0x2e;

/**
 * Lowercase an HTTP header name with normalization that matches Node's behavior for
 * incoming headers: case-insensitive lookup that lowercases ASCII A–Z to a–z.
 */
function normalizeHeaderName(name: string): string {
  return name.toLowerCase();
}

/** Pull a header value as a single string regardless of whether it is a string or array. */
function readHeader(headers: WebhookHeaders, name: string): string | undefined {
  const raw = headers.get(name);
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Trim the OWS (HTTP "optional whitespace") off both ends of a header value. Done in
 * one place so the verifier does not allow stuffing the body with leading whitespace
 * that changes the signed bytes.
 */
function trimOws(value: string): string {
  // RFC 7230 §3.2.3: optional whitespace is SP / HTAB. Avoid trimming arbitrary
  // whitespace that could change signed bytes if the sender sent leading/trailing NULs.
  return value.replace(/^[ \t]+|[ \t]+$/g, '');
}

/**
 * Decode a signature string per the configured encoding. Returns null if the input
 * is malformed for the encoding or the resulting byte length is not the HMAC-SHA256
 * output length (32 bytes). Length is checked before HMAC comparison so a length-
 * mismatch cannot be turned into a side channel.
 */
function decodeSignature(encoded: string, encoding: 'hex' | 'base64'): Buffer | null {
  let bytes: Buffer;
  try {
    if (encoding === 'hex') {
      if (!/^[0-9a-fA-F]+$/.test(encoded)) return null;
      if (encoded.length % 2 !== 0) return null;
      bytes = Buffer.from(encoded, 'hex');
      if (bytes.length !== 32) return null;
    } else {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
      bytes = Buffer.from(encoded, 'base64');
      // Re-encode and compare to verify padding/characters were well-formed (Buffer.from
      // is lenient and accepts garbage by ignoring characters).
      if (bytes.length !== 32) return null;
      if (bytes.toString('base64') !== encoded) return null;
    }
  } catch {
    return null;
  }
  return bytes;
}

/**
 * Parse the timestamp header as a non-negative integer. Returns the integer and its
 * canonical decimal string form so the verifier can use the latter as part of the
 * signed bytes.
 *
 * **Canonicalization:** the returned `text` is exactly `String(n)`. This is the
 * ONE form that participates in the HMAC input. Consequences for senders:
 *
 *   - Leading zeros in the header (e.g. `"01767230430"`) are stripped — the
 *     canonical text is `"1767230430"`. A sender who signed the literal header
 *     text (including the leading zero) produces a different HMAC and is
 *     rejected as `signature_mismatch`. A sender who signed the canonical
 *     `String(n)` form matches.
 *   - Optional whitespace around the header value is trimmed before parsing;
 *     the canonical text never contains whitespace. Same rule: signing the
 *     literal header text (whitespace included) produces a different HMAC.
 *   - `+`, `-`, `.`, leading sign, decimal, hex, or any other non-decimal shape
 *     is rejected by the regex as `timestamp_malformed` before the HMAC is even
 *     considered. There is no "tolerant" parse path.
 *
 * This makes the signed-byte representation deterministic — the same integer
 * always produces the same bytes — and rules out any ambiguity a sender could
 * exploit to encode the timestamp differently from what the verifier expects.
 *
 * Returns null if the value is empty after trim, contains a non-digit character,
 * or falls outside the implausible-time bounds (year 1989-01-06..year 2096).
 */
function parseTimestamp(raw: string): { readonly seconds: number; readonly text: string } | null {
  const trimmed = trimOws(raw);
  if (trimmed === '') return null;
  if (!/^[0-9]+$/.test(trimmed)) return null;
  // Reject values that overflow a safe integer — they cannot be reasonable seconds.
  if (!/^[0-9]{1,16}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  // Reject values that, after parsing, would represent a wall-clock time implausibly
  // far in the future or before the platform even existed. ±10⁹ seconds (~31 years)
  // is the bound — anything outside is unambiguously not a real timestamp. The lower
  // bound is inclusive: anything at or before 1989-01-06T17:07:40Z is rejected as
  // malformed, not as merely out-of-tolerance.
  if (n > 4_000_000_000 || n < 600_000_001) return null;
  // `text` is exactly String(n) — the single deterministic form that goes into the
  // HMAC. See the docblock above for the canonicalization contract.
  return { seconds: n, text: String(n) };
}

/**
 * Build the canonical bytes the HMAC is computed over for a given mode. Deterministic
 * — the same inputs (rawBody + parsed timestamp) always produce the same Buffer. The
 * bytes do not include the encoding of the signature itself; they are what the
 * provider agreed to sign.
 */
function buildSignedBytes(
  cfg: WebhookSignatureConfig,
  rawBody: Buffer,
  timestamp: { readonly seconds: number; readonly text: string } | null,
): Buffer | null {
  if (cfg.signing_input === 'raw_body') {
    return rawBody;
  }
  // timestamp_and_body
  if (timestamp === null) return null;
  // <timestamp_text> || "." || rawBody — single concat, no intermediate copies.
  return Buffer.concat([
    Buffer.from(timestamp.text, 'utf8'),
    Buffer.from([SIGNED_INPUT_SEPARATOR]),
    rawBody,
  ]);
}

/**
 * Compute the HMAC-SHA256 over the canonical signed bytes, returning exactly 32 bytes.
 * Encoded form on the wire is the caller's choice (hex/base64).
 */
function computeHmac(key: Buffer, signedBytes: Buffer): Buffer {
  return createHmac(HMAC_ALGORITHM, key).update(signedBytes).digest();
}

/**
 * Compare two 32-byte buffers in constant time. Buffer lengths are checked first
 * because `timingSafeEqual` throws on length mismatch.
 */
function safeMacEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify a webhook signature against a config and shared secret.
 *
 * Does **not** log, persist, or echo the body, the signature value, or the secret.
 * Test code can wrap this in a logger; production callers pass `new Date()` for
 * `input.now` and read `headers` from the Fastify request via a small adapter.
 *
 * Returns a {@link VerifyResult} that always includes a reason on failure. Reason
 * codes are stable and meant for structured logs; the route translates them to a
 * generic 401 so a caller cannot probe by reason text.
 *
 * **What this guarantees (`timestamp_and_body` mode):**
 *
 *   - The timestamp is part of the signed bytes (canonicalized via `String(n)`).
 *     Mutating either the timestamp OR the body breaks the HMAC and is rejected.
 *   - A captured delivery cannot be replayed outside the configured
 *     `tolerance_seconds` window — both stale and far-future timestamps fail
 *     `timestamp_out_of_tolerance`.
 *   - Within the tolerance window, an EXACT replay of the same `(timestamp,
 *     body, signature)` is NOT rejected by this verifier; suppression of such
 *     duplicates is the responsibility of the route's `X-Event-ID` dedupe layer
 *     (which is caller-controlled and is a known separate concern).
 */
export function verifyWebhookSignature(
  input: VerifyInput,
  cfg: WebhookSignatureConfig,
  secret: string,
): VerifyResult {
  // 1. Pull and validate the signature header (and optional prefix).
  const signatureRaw = readHeader(input.headers, cfg.signature_header);
  if (signatureRaw === undefined) {
    return { outcome: 'invalid', reason: 'signature_header_missing' };
  }
  let signatureValue = signatureRaw;
  if (cfg.signature_prefix !== undefined) {
    if (!signatureValue.startsWith(cfg.signature_prefix)) {
      return { outcome: 'invalid', reason: 'signature_malformed' };
    }
    signatureValue = signatureValue.slice(cfg.signature_prefix.length);
  }
  const providedMac = decodeSignature(signatureValue, cfg.signature_encoding);
  if (providedMac === null) {
    return { outcome: 'invalid', reason: 'signature_malformed' };
  }

  // 2. In `timestamp_and_body` mode, validate the timestamp header before doing
  //    anything else. The header is parsed into a non-negative integer and the
  //    canonical text is `String(n)` — leading zeros and whitespace are stripped
  //    so the signed bytes are deterministic. A missing/malformed timestamp is
  //    rejected as such; an out-of-tolerance timestamp is rejected as such;
  //    both are kept distinct from `signature_mismatch` so a defender reading
  //    logs can tell which guard fired.
  let timestamp: { readonly seconds: number; readonly text: string } | null = null;
  if (cfg.signing_input === 'timestamp_and_body') {
    const tsRaw = readHeader(input.headers, cfg.timestamp_header);
    if (tsRaw === undefined) {
      return { outcome: 'invalid', reason: 'timestamp_header_missing' };
    }
    timestamp = parseTimestamp(tsRaw);
    if (timestamp === null) {
      return { outcome: 'invalid', reason: 'timestamp_malformed' };
    }
    const nowSeconds = Math.floor(input.now.getTime() / 1000);
    const delta = Math.abs(nowSeconds - timestamp.seconds);
    if (delta > cfg.tolerance_seconds) {
      return { outcome: 'invalid', reason: 'timestamp_out_of_tolerance' };
    }
  }

  // 3. Build the canonical signed bytes and compute HMAC.
  const secretKey = Buffer.from(secret, 'utf8');
  if (secretKey.length === 0) {
    // A zero-length key would still "work" with HMAC but match nothing a sender with
    // a real key would produce. Reject explicitly so the misconfiguration is loud
    // rather than a silent mismatch that looks like a forgery.
    return { outcome: 'invalid', reason: 'signature_mismatch' };
  }
  const signedBytes = buildSignedBytes(cfg, input.rawBody, timestamp);
  if (signedBytes === null) {
    // `timestamp_and_body` already validated the timestamp above, so this branch is
    // only reachable if the schema internal logic changes. Defensive, never logged
    // because it indicates a programming error in the verifier, not an attacker input.
    return { outcome: 'invalid', reason: 'signature_mismatch' };
  }
  const computedMac = computeHmac(secretKey, signedBytes);

  // 4. Constant-time compare.
  return safeMacEqual(computedMac, providedMac)
    ? { outcome: 'valid' }
    : { outcome: 'invalid', reason: 'signature_mismatch' };
}

/**
 * Helper for callers (and the route's tests) that have a Node IncomingMessage and
 * want the same lowercase-header lookup behavior the production path uses. Kept
 * here because the Fastify-typed adapter in the route layer depends on it.
 */
export function nodeHeaderLookup(headers: NodeJS.Dict<string | string[]>): WebhookHeaders {
  return {
    get(name: string): string | undefined {
      const key = normalizeHeaderName(name);
      const value = headers[key];
      if (value === undefined) return undefined;
      return Array.isArray(value) ? value[0] : value;
    },
  };
}
