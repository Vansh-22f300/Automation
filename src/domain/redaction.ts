/**
 * The first real redaction policy — deliberately small, defense-in-depth, and
 * pure.
 *
 * This is NOT a DLP system. Its job is narrow: turn stored, possibly-sensitive
 * values into shapes that are safe to hand an operator by default, and to catch
 * the few high-confidence secret shapes that should never appear in an inspection
 * response even in an explicit detail view. The primary defense remains *not
 * storing secrets* in these columns at all (already true across the schema); this
 * module is the belt to that braces.
 *
 * Three capabilities, each independently unit-tested:
 *   1. `toSafeError`   — a stored jsonb error → `{ code, message, retryable? }`,
 *                        dropping `details`, stacks and anything else.
 *   2. `summarizeValue`— any value → `{ bytes, preview, truncated }`: a size and a
 *                        secret-redacted, length-capped preview. The default,
 *                        safe-by-default representation of payload/context/output.
 *   3. `redactDeep`    — a bounded recursive secret scrub, for the explicit detail
 *                        view (CLI `--detail`) that returns raw values.
 */

/** The client-safe error shape. Never carries `details`, a stack, or an exception. */
export interface SafeErrorDto {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}

/** A safe, bounded summary of a possibly-large, possibly-sensitive value. */
export interface ValueSummary {
  /** Byte length of the full JSON encoding — an honest size, not the preview's. */
  readonly bytes: number;
  /** A secret-redacted, length-capped rendering. Never the whole value if large. */
  readonly preview: string;
  /** True when the preview was cut short of the full value. */
  readonly truncated: boolean;
}

/** Preview length cap, in characters. Full size is always reported separately. */
export const MAX_PREVIEW_CHARS = 512;

/** Depth beyond which `redactDeep` stops descending and elides the subtree. */
export const MAX_REDACT_DEPTH = 10;

/**
 * High-confidence secret shapes. Conservative on purpose — a missed exotic secret
 * is preferable to mangling every benign identifier. Ordered longest/most-specific
 * first so overlapping matches redact as the more specific reason.
 */
const SECRET_PATTERNS: readonly { readonly re: RegExp; readonly label: string }[] = [
  { re: /Bearer\s+[A-Za-z0-9._~+/-]+=*/g, label: 'bearer' },
  { re: /xox[baprs]-[A-Za-z0-9-]+/g, label: 'slack-token' },
  { re: /sk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, label: 'api-key' },
  { re: /\b[0-9a-fA-F]{40,}\b/g, label: 'hex-secret' },
];

/** JSON `"key": "value"` pairs whose key names a secret — redact the value. */
const SECRET_KEY_VALUE_RE =
  /("(?:password|secret|token|api_?key|authorization|credential|private_?key)"\s*:\s*)"[^"]*"/gi;

/** Object keys (for `redactDeep`) that name a secret regardless of value shape. */
const SECRET_KEY_RE =
  /^(password|secret|token|api_?key|authorization|credential|private_?key)$/i;

/** Replace high-confidence secret substrings in a single string. */
export function redactSecrets(input: string): string {
  let out = input.replace(SECRET_KEY_VALUE_RE, (_m, prefix: string) => `${prefix}"«redacted:secret-key»"`);
  for (const { re, label } of SECRET_PATTERNS) {
    out = out.replace(re, `«redacted:${label}»`);
  }
  return out;
}

/**
 * Map a stored jsonb error (or anything) to the client-safe error shape, or null.
 * Only `code`, `message` and an optional boolean `retryable` survive; `details`,
 * stacks and unknown fields are dropped. `message` is secret-redacted defensively.
 */
export function toSafeError(raw: unknown): SafeErrorDto | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : 'unknown_error';
  const message =
    typeof record.message === 'string' ? redactSecrets(record.message) : 'An error occurred';
  const retryable = typeof record.retryable === 'boolean' ? record.retryable : undefined;
  return { code, message, ...(retryable !== undefined ? { retryable } : {}) };
}

/** JSON-encode a value defensively — a circular/BigInt value becomes a marker. */
function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json ?? 'null';
  } catch {
    return '«unserializable»';
  }
}

/**
 * Summarize any value: its true byte size plus a secret-redacted, length-capped
 * preview. This is the safe-by-default rendering of payloads, context and step
 * output — an operator sees the size and a bounded, scrubbed glimpse, never the
 * whole customer value.
 */
export function summarizeValue(value: unknown): ValueSummary {
  const json = safeStringify(value);
  const bytes = Buffer.byteLength(json, 'utf8');
  const redacted = redactSecrets(json);
  const truncated = redacted.length > MAX_PREVIEW_CHARS;
  const preview = truncated
    ? `${redacted.slice(0, MAX_PREVIEW_CHARS)}…(truncated, ${bytes} bytes)`
    : redacted;
  return { bytes, preview, truncated };
}

/**
 * A bounded, recursive secret scrub for the explicit detail view. Strings are
 * run through `redactSecrets`; object values under a secret-named key are elided
 * wholesale; recursion stops at `MAX_REDACT_DEPTH`. Returns a new value; the input
 * is never mutated.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth >= MAX_REDACT_DEPTH) return '«redacted:depth»';
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) ? '«redacted:secret-key»' : redactDeep(val, depth + 1);
    }
    return out;
  }
  return value;
}
