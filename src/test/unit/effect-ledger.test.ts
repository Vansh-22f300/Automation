/**
 * Effect-ledger classification unit tests: the two-axis contract, proven pure.
 *
 * `classifyEffectFailure` is the single place that decides what a connector
 * failure MEANS for its reservation — release (re-run), permanent (fail), or
 * ambiguous (hold, never resend). It is deliberately dependency-free so the whole
 * decision table can be asserted here with no database and no connector.
 *
 * The one rule that must never regress: anything that is not EXPLICITLY a
 * `safe` retryable failure settles as ambiguous or permanent — never released for
 * a resend. `effectSafetyOf` enforces that fail-safe default, and these tests pin
 * every branch of it, including the untagged and non-AppError cases.
 */

import { describe, expect, it } from 'vitest';

import { AmbiguousEffectError, PermanentError, RetryableError } from '@/domain/errors.js';
import { classifyEffectFailure, effectSafetyOf } from '@/domain/effect-ledger.js';
import { EFFECT_SAFETY_DETAIL_KEY } from '@/domain/tool.js';

describe('effectSafetyOf', () => {
  it('reads an explicit safe tag as safe', () => {
    const error = new RetryableError('slack_rate_limited', 'slow down', {
      details: { [EFFECT_SAFETY_DETAIL_KEY]: 'safe' },
    });
    expect(effectSafetyOf(error)).toBe('safe');
  });

  it('reads an explicit ambiguous tag as ambiguous', () => {
    const error = new RetryableError('slack_5xx', 'server error', {
      details: { [EFFECT_SAFETY_DETAIL_KEY]: 'ambiguous' },
    });
    expect(effectSafetyOf(error)).toBe('ambiguous');
  });

  it('treats an untagged AppError as ambiguous (fail-safe)', () => {
    expect(effectSafetyOf(new RetryableError('slack_5xx', 'server error'))).toBe('ambiguous');
  });

  it('treats an unrecognised tag value as ambiguous (fail-safe)', () => {
    const error = new RetryableError('weird', 'x', { details: { [EFFECT_SAFETY_DETAIL_KEY]: 'maybe' } });
    expect(effectSafetyOf(error)).toBe('ambiguous');
  });

  it('treats a non-AppError as ambiguous (fail-safe)', () => {
    expect(effectSafetyOf(new Error('boom'))).toBe('ambiguous');
    expect(effectSafetyOf('boom')).toBe('ambiguous');
    expect(effectSafetyOf(undefined)).toBe('ambiguous');
  });
});

describe('classifyEffectFailure', () => {
  it('classifies a permanent error as permanent (deterministic; settle failed)', () => {
    const disposition = classifyEffectFailure(new PermanentError('slack_bad_request', 'invalid channel'));
    expect(disposition.kind).toBe('permanent');
    expect(disposition.error).toEqual({ code: 'slack_bad_request', message: 'invalid channel', retryable: false });
  });

  it('classifies a SAFE retryable error as release (write did not happen; re-run allowed)', () => {
    const error = new RetryableError('slack_rate_limited', 'rate limited', {
      details: { [EFFECT_SAFETY_DETAIL_KEY]: 'safe', retryAfterSeconds: 30 },
    });
    const disposition = classifyEffectFailure(error);
    expect(disposition.kind).toBe('release');
    expect(disposition.error).toEqual({ code: 'slack_rate_limited', message: 'rate limited', retryable: true });
  });

  it('classifies an AMBIGUOUS retryable error as ambiguous (outcome unknown; hold)', () => {
    const error = new RetryableError('slack_5xx', 'server error', {
      details: { [EFFECT_SAFETY_DETAIL_KEY]: 'ambiguous', status: 503 },
    });
    const disposition = classifyEffectFailure(error);
    expect(disposition.kind).toBe('ambiguous');
    expect(disposition.error.code).toBe('slack_5xx');
  });

  it('classifies an UNTAGGED retryable error as ambiguous (fail-safe default)', () => {
    const disposition = classifyEffectFailure(new RetryableError('slack_network_error', 'reset'));
    expect(disposition.kind).toBe('ambiguous');
    expect(disposition.error.code).toBe('slack_network_error');
  });

  it('classifies a non-AppError crash as ambiguous, never released', () => {
    const disposition = classifyEffectFailure(new Error('kaboom'));
    expect(disposition.kind).toBe('ambiguous');
    expect(disposition.error.code).toBe('effect_connector_crashed');
    expect(disposition.error.message).toBe('kaboom');
    expect(disposition.error.retryable).toBe(false);
  });

  it('keeps an already-ambiguous error ambiguous (defensive re-entry)', () => {
    const disposition = classifyEffectFailure(new AmbiguousEffectError('unknown outcome'));
    expect(disposition.kind).toBe('ambiguous');
    expect(disposition.error.code).toBe('effect_ambiguous');
  });

  it('holds (never resends) even when a recovery policy other than hold_ambiguous is declared', () => {
    // resend_safe / reconcile machinery is not implemented; until it is, an
    // ambiguous retryable failure must still HOLD, never silently resend.
    const error = new RetryableError('slack_5xx', 'server error', {
      details: { [EFFECT_SAFETY_DETAIL_KEY]: 'ambiguous' },
    });
    expect(classifyEffectFailure(error, 'resend_safe').kind).toBe('ambiguous');
    expect(classifyEffectFailure(error, 'reconcile').kind).toBe('ambiguous');
    expect(classifyEffectFailure(error, 'hold_ambiguous').kind).toBe('ambiguous');
  });

  it('a SAFE assertion still releases regardless of recovery policy', () => {
    // effect-safety is the stronger signal: if the write provably did not happen,
    // the reservation is released for a genuine retry no matter the policy.
    const error = new RetryableError('slack_rate_limited', 'rl', {
      details: { [EFFECT_SAFETY_DETAIL_KEY]: 'safe' },
    });
    expect(classifyEffectFailure(error, 'resend_safe').kind).toBe('release');
    expect(classifyEffectFailure(error, 'hold_ambiguous').kind).toBe('release');
  });
});
