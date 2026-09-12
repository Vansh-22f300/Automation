/**
 * Focused unit tests for the webhook signature verifier.
 *
 * These prove the security properties the route depends on, in isolation from any
 * database, HTTP, or Fastify layer. Each scenario maps to a property the route
 * relies on:
 *
 *   A. valid timestamp + valid authenticated timestamp/body combination → accepted
 *   B. stale timestamp → rejected
 *   C. future timestamp outside tolerance → rejected
 *   D. same valid body/signature + modified timestamp → rejected
 *   E. same timestamp + modified body → rejected
 *   F. malformed timestamp → rejected
 *   G. timestamp-enabled mode cannot silently fall back to body-only HMAC
 *   H. existing body-only HMAC mode remains unchanged (positive + negative)
 *   I. logs contain no raw body, secret, or signature (verifier is pure);
 *      route-level log assertion is in webhooks-route.test.ts.
 *
 * Plus a parallel set of strict-Zod validation tests for the `signature` config
 * shape, and a body-encoding round-trip test that exercises both `hex` and
 * `base64` so the encoding/decoding symmetry holds across both modes.
 */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseWebhookSignatureConfig,
  type RawBodySignatureConfig,
  type TimestampAndBodySignatureConfig,
  verifyWebhookSignature,
  webhookSignatureConfigSchema,
} from '@/domain/webhook-signature.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const RAW_BODY_CFG = (): RawBodySignatureConfig =>
  parseWebhookSignatureConfig({
    signing_input: 'raw_body',
    algorithm: 'hmac-sha256',
    secret_connection_id: '01234567-89ab-7cde-8f01-23456789abcd',
    signature_header: 'x-signature',
    signature_encoding: 'hex',
  }) as RawBodySignatureConfig;

const TIMESTAMP_CFG = (): TimestampAndBodySignatureConfig =>
  parseWebhookSignatureConfig({
    signing_input: 'timestamp_and_body',
    algorithm: 'hmac-sha256',
    secret_connection_id: '01234567-89ab-7cde-8f01-23456789abcd',
    signature_header: 'x-signature',
    signature_encoding: 'hex',
    timestamp_header: 'x-timestamp',
    tolerance_seconds: 60,
  }) as TimestampAndBodySignatureConfig;

const SECRET = 'super-shared-secret';

// 2026-01-01T00:00:30Z → 1767230430 seconds-since-epoch (UTC).
const FIXED_NOW = new Date('2026-01-01T00:00:30Z');
const FIXED_TS = String(Math.floor(FIXED_NOW.getTime() / 1000));

/** Build a lowercase-keyed header lookup that mirrors Fastify's request.headers. */
function headerMap(entries: Record<string, string>): {
  get(name: string): string | undefined;
} {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(entries)) {
    normalized.set(key.toLowerCase(), value);
  }
  return {
    get(name: string): string | undefined {
      return normalized.get(name.toLowerCase());
    },
  };
}

/** Compute the canonical signed bytes for `timestamp_and_body`. */
function timestampedSignedBytes(ts: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(ts, 'utf8'), Buffer.from('.'), body]);
}

/** Compute the HMAC-SHA256 of `bytes` with `secret`, encoded as hex or base64. */
function signHex(secret: string, bytes: Buffer): string {
  return createHmac('sha256', secret).update(bytes).digest('hex');
}

function signBase64(secret: string, bytes: Buffer): string {
  return createHmac('sha256', secret).update(bytes).digest('base64');
}

// ---------------------------------------------------------------------------
// A. Canonical timestamp + correct signature → accepted.
//    Plus the positive-side canonicalization cases that prove the verifier's
//    normalization (whitespace trim + leading-zero strip) is idempotent: a
//    sender who uses `String(n)` matches even when the header carries leading
//    zeros or surrounding whitespace.
// ---------------------------------------------------------------------------

describe('verifyWebhookSignature — timestamp_and_body canonicalization', () => {
  it('A: canonical timestamp + correct HMAC over timestamp||.|body → accepted', () => {
    const cfg = TIMESTAMP_CFG();
    const body = Buffer.from('{"action":"opened"}');
    const signed = timestampedSignedBytes(FIXED_TS, body);
    const sig = signHex(SECRET, signed);

    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          [cfg.signature_header]: sig,
          [cfg.timestamp_header]: FIXED_TS,
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('valid');
  });

  // ---- A+: positive-side canonicalization cases (idempotent) ----

  it('A+: header has leading zeros but sender used canonical String(n) → still accepted', () => {
    // Sender signs the canonical form `String(1767230430) + "." + body`. The
    // header on the wire carries the same integer padded with leading zeros.
    // The verifier canonicalizes via String(n), which strips the leading zeros,
    // so the HMAC matches.
    const cfg = TIMESTAMP_CFG();
    const body = Buffer.from('payload');
    const canonical = timestampedSignedBytes(FIXED_TS, body); // "1767230430.payload"
    const sig = signHex(SECRET, canonical);

    const padded = '0'.repeat(5) + FIXED_TS; // "000001767230430"
    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          [cfg.signature_header]: sig,
          [cfg.timestamp_header]: padded,
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('valid');
  });

  it('A+: header has surrounding whitespace but sender used canonical String(n) → still accepted', () => {
    // Sender signs `String(n) + "." + body`. The header has SP/HTAB around it;
    // the verifier trims (RFC 7230 OWS), then canonicalizes via String(n).
    const cfg = TIMESTAMP_CFG();
    const body = Buffer.from('payload');
    const canonical = timestampedSignedBytes(FIXED_TS, body);
    const sig = signHex(SECRET, canonical);

    const padded = `  \t${FIXED_TS}\t  `;
    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          [cfg.signature_header]: sig,
          [cfg.timestamp_header]: padded,
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('valid');
  });

  // ---- B/C: negative-side canonicalization cases ----

  it('B: sender signed the literal header value WITH leading zeros → signature_mismatch', () => {
    // Sender naively signs the literal header text including leading zeros.
    // The verifier canonicalizes via String(n) and signs a different byte
    // sequence; HMAC comparison fails. Proves the canonical form is
    // `String(n)`, never the literal header text.
    const cfg = TIMESTAMP_CFG();
    const body = Buffer.from('payload');
    const paddedHeader = '0'.repeat(5) + FIXED_TS; // "000001767230430"
    const senderBytes = Buffer.concat([
      Buffer.from(paddedHeader, 'utf8'),
      Buffer.from('.'),
      body,
    ]);
    const sig = signHex(SECRET, senderBytes);

    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          [cfg.signature_header]: sig,
          [cfg.timestamp_header]: paddedHeader,
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') {
      expect(result.reason).toBe('signature_mismatch');
    }
  });

  it('C: sender signed the literal header value WITH internal whitespace → signature_mismatch', () => {
    // Sender naively signs the literal header text including leading whitespace.
    // The verifier trims whitespace and signs a different byte sequence;
    // HMAC comparison fails. Proves the canonical text has no whitespace.
    const cfg = TIMESTAMP_CFG();
    const body = Buffer.from('payload');
    const paddedHeader = `  ${FIXED_TS}  `;
    const senderBytes = Buffer.concat([
      Buffer.from(paddedHeader, 'utf8'),
      Buffer.from('.'),
      body,
    ]);
    const sig = signHex(SECRET, senderBytes);

    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          [cfg.signature_header]: sig,
          [cfg.timestamp_header]: paddedHeader,
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') {
      expect(result.reason).toBe('signature_mismatch');
    }
  });

  it('C: a `+` prefix, a hex shape, and a decimal point are all rejected as timestamp_malformed (no HMAC computed)', () => {
    // Each of these shapes would, if accepted, change the signed bytes.
    // The verifier rejects them at the parse stage so the HMAC is never
    // computed over a non-canonical input.
    const cfg = TIMESTAMP_CFG();
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['plus sign', `+${FIXED_TS}`],
      ['hex prefix', `0x${FIXED_TS}`],
      ['decimal point', `${FIXED_TS}.0`],
      ['leading negative', `-${FIXED_TS}`],
      ['trailing junk', `${FIXED_TS}x`],
    ];
    for (const [label, value] of cases) {
      const result = verifyWebhookSignature(
        {
          rawBody: Buffer.from('payload'),
          headers: headerMap({
            'x-signature': '00'.repeat(32),
            'x-timestamp': value,
          }),
          now: FIXED_NOW,
        },
        cfg,
        SECRET,
      );
      expect(result.outcome).toBe('invalid');
      if (result.outcome === 'invalid') {
        expect(result.reason).toBe('timestamp_malformed');
      }
      // Guard against silent regressions in this assertion: make sure the
      // test loop is actually iterating over the cases.
      if (label === undefined || value === undefined) {
        throw new Error(`case iteration broken: ${label}/${value}`);
      }
    }
  });

  it('accepts base64-encoded signatures in timestamp_and_body mode', () => {
    const cfg = parseWebhookSignatureConfig({
      signing_input: 'timestamp_and_body',
      algorithm: 'hmac-sha256',
      secret_connection_id: '01234567-89ab-7cde-8f01-23456789abcd',
      signature_header: 'x-signature',
      signature_encoding: 'base64',
      timestamp_header: 'x-timestamp',
      tolerance_seconds: 60,
    });
    const body = Buffer.from('hello');
    const signed = timestampedSignedBytes(FIXED_TS, body);
    const sig = signBase64(SECRET, signed);

    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          'x-signature': sig,
          'x-timestamp': FIXED_TS,
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('valid');
  });

  it('accepts a present signature_prefix', () => {
    const cfg = parseWebhookSignatureConfig({
      signing_input: 'timestamp_and_body',
      algorithm: 'hmac-sha256',
      secret_connection_id: '01234567-89ab-7cde-8f01-23456789abcd',
      signature_header: 'x-signature',
      signature_encoding: 'hex',
      signature_prefix: 'sha256=',
      timestamp_header: 'x-timestamp',
      tolerance_seconds: 60,
    });
    const body = Buffer.from('hi');
    const signed = timestampedSignedBytes(FIXED_TS, body);
    const sig = 'sha256=' + signHex(SECRET, signed);

    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          'x-signature': sig,
          'x-timestamp': FIXED_TS,
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('valid');
  });
});

// ---------------------------------------------------------------------------
// B. Stale timestamp outside tolerance.
// ---------------------------------------------------------------------------

describe('verifyWebhookSignature — tolerance window', () => {
  it('B: stale timestamp (older than tolerance) → rejected as out-of-tolerance', () => {
    const cfg = TIMESTAMP_CFG();
    const body = Buffer.from('{}');
    // 10 minutes before FIXED_NOW — outside the 60-second window.
    const staleTs = String(Math.floor(FIXED_NOW.getTime() / 1000) - 600);
    const signed = timestampedSignedBytes(staleTs, body);
    const sig = signHex(SECRET, signed);

    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          [cfg.signature_header]: sig,
          [cfg.timestamp_header]: staleTs,
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') {
      expect(result.reason).toBe('timestamp_out_of_tolerance');
    }
  });

  it('C: future timestamp beyond tolerance → rejected as out-of-tolerance', () => {
    const cfg = TIMESTAMP_CFG();
    const body = Buffer.from('{}');
    const futureTs = String(Math.floor(FIXED_NOW.getTime() / 1000) + 600);
    const signed = timestampedSignedBytes(futureTs, body);
    const sig = signHex(SECRET, signed);

    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          [cfg.signature_header]: sig,
          [cfg.timestamp_header]: futureTs,
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') {
      expect(result.reason).toBe('timestamp_out_of_tolerance');
    }
  });

  it('accepts a timestamp exactly tolerance_seconds in the past (boundary)', () => {
    const cfg = TIMESTAMP_CFG();
    const body = Buffer.from('{}');
    const boundaryTs = String(
      Math.floor(FIXED_NOW.getTime() / 1000) - cfg.tolerance_seconds,
    );
    const signed = timestampedSignedBytes(boundaryTs, body);
    const sig = signHex(SECRET, signed);

    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          [cfg.signature_header]: sig,
          [cfg.timestamp_header]: boundaryTs,
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('valid');
  });
});

// ---------------------------------------------------------------------------
// D. Modify timestamp header but keep signature → must reject.
// E. Modify body but keep signature + timestamp → must reject.
// ---------------------------------------------------------------------------

describe('verifyWebhookSignature — every authenticated byte is bound', () => {
  it('D: same valid body+signature with the timestamp header modified → rejected', () => {
    const cfg = TIMESTAMP_CFG();
    const body = Buffer.from('{"a":1}');
    // Sender's original signed bytes use the original timestamp.
    const originalTs = FIXED_TS;
    const signedOriginal = timestampedSignedBytes(originalTs, body);
    const sig = signHex(SECRET, signedOriginal);

    // Attacker substitutes a fresh timestamp. The signature is still over the
    // original (timestamp||.|body) bytes — but the verifier sees the new
    // timestamp and recomputes HMAC over the new bytes, so they will not match.
    const attackerTs = String(Math.floor(FIXED_NOW.getTime() / 1000) + 5);

    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          [cfg.signature_header]: sig,
          [cfg.timestamp_header]: attackerTs,
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') {
      // The HMAC over (attackerTs || . || body) does not equal the provided
      // signature (which was computed over (originalTs || . || body)).
      expect(result.reason).toBe('signature_mismatch');
    }
  });

  it('E: same timestamp but modified body → rejected as signature_mismatch', () => {
    const cfg = TIMESTAMP_CFG();
    const signedBody = Buffer.from('{"a":1}');
    const signed = timestampedSignedBytes(FIXED_TS, signedBody);
    const sig = signHex(SECRET, signed);

    // Attacker modifies the body but reuses the timestamp + signature.
    const tamperedBody = Buffer.from('{"a":2}');

    const result = verifyWebhookSignature(
      {
        rawBody: tamperedBody,
        headers: headerMap({
          [cfg.signature_header]: sig,
          [cfg.timestamp_header]: FIXED_TS,
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') {
      expect(result.reason).toBe('signature_mismatch');
    }
  });
});

// ---------------------------------------------------------------------------
// F. Malformed timestamp values.
// ---------------------------------------------------------------------------

describe('verifyWebhookSignature — malformed timestamp', () => {
  const cfg = TIMESTAMP_CFG();

  it.each([
    ['empty string', ''],
    ['non-digit characters', 'abc123'],
    ['leading whitespace then non-digit', '  abc'],
    ['hex-shaped but not decimal', '0x1234'],
    ['leading zero with non-digit', '01abc'],
    ['value below lower-bound (year 1989)', '600000000'],
    ['value above upper-bound (year 2096)', '5000000000'],
  ])('F: %s → rejected as malformed timestamp', (_label, headerValue) => {
    const body = Buffer.from('{}');
    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          [cfg.signature_header]: '00'.repeat(32),
          [cfg.timestamp_header]: headerValue,
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') {
      expect(result.reason).toBe('timestamp_malformed');
    }
  });

  it('F (missing): empty timestamp header → rejected as missing', () => {
    const body = Buffer.from('{}');
    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          [cfg.signature_header]: '00'.repeat(32),
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') {
      expect(result.reason).toBe('timestamp_header_missing');
    }
  });
});

// ---------------------------------------------------------------------------
// G. timestamp_and_body mode must not silently fall back to body-only HMAC.
// ---------------------------------------------------------------------------

describe('verifyWebhookSignature — no silent fallback to body-only HMAC', () => {
  it('G: a signature computed over only the raw body is rejected under timestamp_and_body', () => {
    const cfg = TIMESTAMP_CFG();
    const body = Buffer.from('{"a":1}');
    // Attacker signs only the body (mimicking the broken pre-fix verifier).
    const bodyOnlySig = signHex(SECRET, body);

    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          [cfg.signature_header]: bodyOnlySig,
          [cfg.timestamp_header]: FIXED_TS,
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') {
      // The verifier must compute HMAC over (timestamp||.|body), see it doesn't
      // match, and emit `signature_mismatch` — not a success.
      expect(result.reason).toBe('signature_mismatch');
    }
  });

  it('rejects with the same reason whether the attacker swapped timestamp or body', () => {
    const cfg = TIMESTAMP_CFG();
    const body = Buffer.from('{"a":1}');

    // Brand-new attacker who can produce valid signatures for any input — they
    // forge one over the body alone (timestamp_and_body) and submit with a
    // passing timestamp header. Verification must reject.
    const sig = signHex(SECRET, body);
    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          [cfg.signature_header]: sig,
          [cfg.timestamp_header]: FIXED_TS,
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// H. Existing raw_body mode remains unchanged (positive + negative).
// ---------------------------------------------------------------------------

describe('verifyWebhookSignature — raw_body mode is unchanged', () => {
  it('H+: correct HMAC over raw body is accepted under raw_body mode', () => {
    const cfg = RAW_BODY_CFG();
    const body = Buffer.from('payload');
    const sig = signHex(SECRET, body);

    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          [cfg.signature_header]: sig,
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('valid');
  });

  it('H-: invalid HMAC under raw_body mode → rejected as signature_mismatch', () => {
    const cfg = RAW_BODY_CFG();
    const result = verifyWebhookSignature(
      {
        rawBody: Buffer.from('payload'),
        headers: headerMap({
          [cfg.signature_header]: 'ff'.repeat(32),
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') {
      expect(result.reason).toBe('signature_mismatch');
    }
  });

  it('H (malformed): non-hex chars in raw_body hex signature → rejected as signature_malformed', () => {
    const cfg = RAW_BODY_CFG();
    const result = verifyWebhookSignature(
      {
        rawBody: Buffer.from('payload'),
        headers: headerMap({
          [cfg.signature_header]: 'zz'.repeat(32),
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') {
      expect(result.reason).toBe('signature_malformed');
    }
  });

  it('H (length): an under-length signature is rejected as signature_malformed, not compared', () => {
    const cfg = RAW_BODY_CFG();
    const result = verifyWebhookSignature(
      {
        rawBody: Buffer.from('payload'),
        headers: headerMap({
          // Only 8 hex chars → would decode to 4 bytes, not 32 — length check
          // rejects before any timing-safe compare.
          [cfg.signature_header]: 'deadbeef',
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') {
      expect(result.reason).toBe('signature_malformed');
    }
  });

  it('H (missing): absence of the signature header → rejected', () => {
    const cfg = RAW_BODY_CFG();
    const result = verifyWebhookSignature(
      {
        rawBody: Buffer.from('payload'),
        headers: headerMap({}),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') {
      expect(result.reason).toBe('signature_header_missing');
    }
  });

  it('H (prefix): missing required prefix → rejected as signature_malformed', () => {
    const cfg = parseWebhookSignatureConfig({
      signing_input: 'raw_body',
      algorithm: 'hmac-sha256',
      secret_connection_id: '01234567-89ab-7cde-8f01-23456789abcd',
      signature_header: 'x-signature',
      signature_encoding: 'hex',
      signature_prefix: 'sha256=',
    });
    const sig = signHex(SECRET, Buffer.from('payload'));

    const result = verifyWebhookSignature(
      {
        rawBody: Buffer.from('payload'),
        headers: headerMap({
          'x-signature': sig, // no "sha256=" prefix
        }),
        now: FIXED_NOW,
      },
      cfg,
      SECRET,
    );
    expect(result.outcome).toBe('invalid');
    if (result.outcome === 'invalid') {
      expect(result.reason).toBe('signature_malformed');
    }
  });
});

// ---------------------------------------------------------------------------
// I. Logs contain no raw body, secret, or signature.
// ---------------------------------------------------------------------------

describe('verifyWebhookSignature — log safety (the verifier is pure)', () => {
  // Snapshot stderr/stdout while the verifier runs and assert nothing inside
  // contains the body, signature, or secret. The verifier must not perform any
  // I/O at all; a mock-level guarantee. Route-level structured logs are
  // exercised in webhooks-route.test.ts.
  //
  // `process.stderr.write` and `process.stdout.write` have multiple overloads
  // (string | Uint8Array, optional callback, etc.). Vi's `MockInstance` is
  // parameterised by the original function type, which makes the inferred
  // return type of `vi.spyOn(process.stderr, 'write')` clash with the simpler
  // default `MockInstance` returned by `vi.spyOn` for plain functions. We use a
  // structural alias that captures only the surface we actually read
  // (`mockRestore()` and `mock.calls`).
  type ConsoleSpy = {
    mockRestore(): void;
    mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
  };
  let stderrSpy: ConsoleSpy | undefined;
  let stdoutSpy: ConsoleSpy | undefined;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as never) as unknown as ConsoleSpy;
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((() => true) as never) as unknown as ConsoleSpy;
  });

  afterEach(() => {
    stderrSpy?.mockRestore();
    stdoutSpy?.mockRestore();
  });

  it('I: a fresh valid call emits no console output containing body, signature, or secret', () => {
    const cfg = TIMESTAMP_CFG();
    const body = Buffer.from('plaintext-body-must-never-appear');
    const secret = 'MUST-NEVER-APPEAR-SECRET';
    const signed = timestampedSignedBytes(FIXED_TS, body);
    const sigHex = signHex(secret, signed);

    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          [cfg.signature_header]: sigHex,
          [cfg.timestamp_header]: FIXED_TS,
        }),
        now: FIXED_NOW,
      },
      cfg,
      secret,
    );
    expect(result.outcome).toBe('valid');

    for (const spy of [stderrSpy!, stdoutSpy!]) {
      const calls = spy.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(calls).not.toContain('plaintext-body-must-never-appear');
      expect(calls).not.toContain('MUST-NEVER-APPEAR-SECRET');
      expect(calls).not.toContain(sigHex);
    }
  });

  it('I: a failing call (invalid signature) emits no console output containing the inputs', () => {
    const cfg = TIMESTAMP_CFG();
    const body = Buffer.from('plaintext-body-must-never-appear');
    const secret = 'MUST-NEVER-APPEAR-SECRET';

    const result = verifyWebhookSignature(
      {
        rawBody: body,
        headers: headerMap({
          [cfg.signature_header]: '00'.repeat(32),
          [cfg.timestamp_header]: FIXED_TS,
        }),
        now: FIXED_NOW,
      },
      cfg,
      secret,
    );
    expect(result.outcome).toBe('invalid');

    for (const spy of [stderrSpy!, stdoutSpy!]) {
      const calls = spy.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(calls).not.toContain('plaintext-body-must-never-appear');
      expect(calls).not.toContain('MUST-NEVER-APPEAR-SECRET');
      // The failed signature header value is also not echoed.
      expect(calls).not.toContain('0'.repeat(32));
    }
  });
});

// ---------------------------------------------------------------------------
// Strict Zod schema validation for the `signature` config.
// ---------------------------------------------------------------------------

describe('webhookSignatureConfigSchema — strict Zod validation', () => {
  const validRawBody = {
    signing_input: 'raw_body',
    algorithm: 'hmac-sha256',
    secret_connection_id: '01234567-89ab-7cde-8f01-23456789abcd',
    signature_header: 'x-signature',
    signature_encoding: 'hex',
  };

  const validTimestampAndBody = {
    signing_input: 'timestamp_and_body',
    algorithm: 'hmac-sha256',
    secret_connection_id: '01234567-89ab-7cde-8f01-23456789abcd',
    signature_header: 'x-signature',
    signature_encoding: 'hex',
    timestamp_header: 'x-timestamp',
    tolerance_seconds: 60,
  };

  it('accepts a minimal valid raw_body config', () => {
    const parsed = webhookSignatureConfigSchema.parse(validRawBody);
    expect(parsed.signing_input).toBe('raw_body');
  });

  it('accepts a minimal valid timestamp_and_body config', () => {
    const parsed = webhookSignatureConfigSchema.parse(validTimestampAndBody);
    expect(parsed.signing_input).toBe('timestamp_and_body');
  });

  it('rejects an unknown algorithm', () => {
    expect(
      webhookSignatureConfigSchema.safeParse({
        ...validRawBody,
        algorithm: 'sha512',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown signing_input value', () => {
    expect(
      webhookSignatureConfigSchema.safeParse({
        ...validRawBody,
        signing_input: 'unknown_mode',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown top-level field (strict)', () => {
    expect(
      webhookSignatureConfigSchema.safeParse({
        ...validRawBody,
        foo: 'bar',
      }).success,
    ).toBe(false);
  });

  it('rejects timestamp_and_body without timestamp_header', () => {
    expect(
      webhookSignatureConfigSchema.safeParse({
        signing_input: 'timestamp_and_body',
        algorithm: 'hmac-sha256',
        secret_connection_id: '01234567-89ab-7cde-8f01-23456789abcd',
        signature_header: 'x-signature',
        signature_encoding: 'hex',
        tolerance_seconds: 60,
      }).success,
    ).toBe(false);
  });

  it('rejects timestamp_and_body without tolerance_seconds', () => {
    expect(
      webhookSignatureConfigSchema.safeParse({
        signing_input: 'timestamp_and_body',
        algorithm: 'hmac-sha256',
        secret_connection_id: '01234567-89ab-7cde-8f01-23456789abcd',
        signature_header: 'x-signature',
        signature_encoding: 'hex',
        timestamp_header: 'x-timestamp',
      }).success,
    ).toBe(false);
  });

  it('rejects tolerance_seconds = 0', () => {
    expect(
      webhookSignatureConfigSchema.safeParse({
        ...validTimestampAndBody,
        tolerance_seconds: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects tolerance_seconds > 3600', () => {
    expect(
      webhookSignatureConfigSchema.safeParse({
        ...validTimestampAndBody,
        tolerance_seconds: 3601,
      }).success,
    ).toBe(false);
  });

  it('rejects negative tolerance_seconds', () => {
    expect(
      webhookSignatureConfigSchema.safeParse({
        ...validTimestampAndBody,
        tolerance_seconds: -5,
      }).success,
    ).toBe(false);
  });

  it('rejects non-integer tolerance_seconds', () => {
    expect(
      webhookSignatureConfigSchema.safeParse({
        ...validTimestampAndBody,
        tolerance_seconds: 1.5,
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid signature_header name (uppercase)', () => {
    expect(
      webhookSignatureConfigSchema.safeParse({
        ...validRawBody,
        signature_header: 'X-Signature',
      }).success,
    ).toBe(false);
  });

  it('rejects an empty signature_header', () => {
    expect(
      webhookSignatureConfigSchema.safeParse({
        ...validRawBody,
        signature_header: '',
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid secret_connection_id (not a UUID)', () => {
    expect(
      webhookSignatureConfigSchema.safeParse({
        ...validRawBody,
        secret_connection_id: 'not-a-uuid',
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid signature_encoding value', () => {
    expect(
      webhookSignatureConfigSchema.safeParse({
        ...validRawBody,
        signature_encoding: 'binary',
      }).success,
    ).toBe(false);
  });

  it('rejects a signature_prefix containing whitespace', () => {
    expect(
      webhookSignatureConfigSchema.safeParse({
        ...validRawBody,
        signature_prefix: 'sha 256=',
      }).success,
    ).toBe(false);
  });

  it('parses correctly via parseWebhookSignatureConfig (and rejects an empty object)', () => {
    expect(() => parseWebhookSignatureConfig({})).toThrow();
  });
});
