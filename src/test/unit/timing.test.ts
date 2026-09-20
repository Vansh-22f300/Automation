/**
 * The lease invariant, guarded arithmetically.
 *
 * `domain/timing.ts` derives the queue lease from the timeouts that actually
 * bound a step. That derivation is only trustworthy while its inputs still match
 * the constants they were copied from — and it deliberately cannot import them,
 * because `config/env.ts` imports it and the Anthropic SDK must not be dragged
 * into configuration parsing. These tests are the seam that keeps the copies
 * honest: change a provider timeout or the tool-round ceiling and one of them
 * fails, pointing straight at the derivation that now needs redoing.
 *
 * The load-bearing assertion is the invariant itself — the lease a claim is
 * granted must exceed the longest a legitimate step can take, or the reaper will
 * hand a still-running job to a second worker.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_SLACK_TIMEOUT_MS } from '@/connectors/slack/slack-client.js';
import {
  DEFAULT_EFFECT_LEASE_MS,
  DEFAULT_LEASE_MS,
  DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS,
  EFFECT_SETTLEMENT_MARGIN_MS,
  LEASE_SAFETY_MARGIN_MS,
  LLM_ROUND_TIMEOUT_BUDGET_MS,
  MAX_LEGITIMATE_STEP_DURATION_MS,
  MAX_TOOL_ROUNDS_BUDGET,
  MIN_SAFE_LEASE_MS,
  STEP_OVERHEAD_BUDGET_MS,
  TOOL_CALLS_PER_ROUND_BUDGET,
  TOOL_CALL_TIMEOUT_BUDGET_MS,
} from '@/domain/timing.js';
import { MAX_TOOL_ROUNDS_LIMIT } from '@/domain/workflow-definition.js';
import { DEFAULT_TIMEOUT_MS } from '@/llm/claude-provider.js';

describe('step-duration budgets track the constants they are derived from', () => {
  it('matches the Claude provider request timeout', () => {
    expect(LLM_ROUND_TIMEOUT_BUDGET_MS).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('matches the Slack tool-call timeout', () => {
    expect(TOOL_CALL_TIMEOUT_BUDGET_MS).toBe(DEFAULT_SLACK_TIMEOUT_MS);
  });

  it('matches the hard ceiling on tool rounds per step', () => {
    expect(MAX_TOOL_ROUNDS_BUDGET).toBe(MAX_TOOL_ROUNDS_LIMIT);
  });
});

describe('MAX_LEGITIMATE_STEP_DURATION_MS', () => {
  it('is the documented worst case: 5 × (60s + 4 × 10s) + 60s = 9m20s', () => {
    expect(MAX_LEGITIMATE_STEP_DURATION_MS).toBe(560_000);
    expect(MAX_LEGITIMATE_STEP_DURATION_MS).toBe(
      MAX_TOOL_ROUNDS_BUDGET *
        (LLM_ROUND_TIMEOUT_BUDGET_MS +
          TOOL_CALLS_PER_ROUND_BUDGET * TOOL_CALL_TIMEOUT_BUDGET_MS) +
        STEP_OVERHEAD_BUDGET_MS,
    );
  });

  it('assumes more than one tool call per round', () => {
    // The loop in `domain/step-handler.ts` executes every tool call the provider
    // returned, sequentially and with no per-round cap. A budget of 1 — which an
    // earlier draft of this derivation used — understates the tail badly.
    expect(TOOL_CALLS_PER_ROUND_BUDGET).toBeGreaterThan(1);
  });
});

describe('DEFAULT_LEASE_MS', () => {
  it('exceeds the worst-case legitimate step duration', () => {
    // The invariant. If this ever fails, a step can outlive its lease and the
    // reaper will hand the same job to a second worker while the first still runs.
    expect(DEFAULT_LEASE_MS).toBeGreaterThan(MAX_LEGITIMATE_STEP_DURATION_MS);
  });

  it('keeps the whole safety margin above it', () => {
    expect(MIN_SAFE_LEASE_MS).toBe(MAX_LEGITIMATE_STEP_DURATION_MS + LEASE_SAFETY_MARGIN_MS);
    expect(DEFAULT_LEASE_MS).toBeGreaterThanOrEqual(MIN_SAFE_LEASE_MS);
  });

  it('is fifteen minutes', () => {
    expect(DEFAULT_LEASE_MS).toBe(900_000);
  });

  it('survives the tool-call budget being wrong by a factor of two', () => {
    // Nothing in the code stops a model from emitting eight tool calls in a round
    // instead of four, so the lease must still hold if the one budgeted assumption
    // in the derivation turns out to be double what we guessed.
    const pessimistic =
      MAX_TOOL_ROUNDS_BUDGET *
        (LLM_ROUND_TIMEOUT_BUDGET_MS +
          2 * TOOL_CALLS_PER_ROUND_BUDGET * TOOL_CALL_TIMEOUT_BUDGET_MS) +
      STEP_OVERHEAD_BUDGET_MS;

    expect(DEFAULT_LEASE_MS).toBeGreaterThan(pessimistic);
  });
});

describe('DEFAULT_EFFECT_LEASE_MS', () => {
  it('is the documented 120 seconds', () => {
    expect(DEFAULT_EFFECT_LEASE_MS).toBe(120_000);
  });

  it('sits strictly above one connector call and below the job lease', () => {
    // The load-bearing effect-lease invariant:
    //   max connector execution < effect lease < job lease.
    // Break either bound and the effect ledger either declares a still-running
    // call "ambiguous" (lower bound) or asserts an effect held longer than its
    // own job could survive (upper bound).
    expect(TOOL_CALL_TIMEOUT_BUDGET_MS).toBeLessThan(DEFAULT_EFFECT_LEASE_MS);
    expect(DEFAULT_EFFECT_LEASE_MS).toBeLessThan(DEFAULT_LEASE_MS);
  });

  it('clears one connector call by more than a factor of ten', () => {
    // Not a taste check: the settlement after a returned connector call must fit
    // comfortably inside the lease, so the healthy path never brushes expiry.
    expect(DEFAULT_EFFECT_LEASE_MS).toBeGreaterThan(TOOL_CALL_TIMEOUT_BUDGET_MS * 10);
  });
});

describe('EFFECT_SETTLEMENT_MARGIN_MS', () => {
  it('is a positive additive defer buffer', () => {
    // Added to the *remaining* lease when deferring against a live reservation,
    // so it is deliberately free to exceed the lease; its only hard requirement
    // is to be positive so one deferral lands strictly past the lease horizon.
    expect(EFFECT_SETTLEMENT_MARGIN_MS).toBeGreaterThan(0);
  });

  it('clears the 30s statement/idle-in-transaction settlement bound', () => {
    // A settlement commit is bounded by the 30s statement and
    // idle-in-transaction timeouts in `db/client.ts`; the margin must exceed
    // that so a deferring attempt cannot wake while the owner is still settling.
    expect(EFFECT_SETTLEMENT_MARGIN_MS).toBeGreaterThan(30_000);
  });
});

describe('DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS', () => {
  it('matches the API process shutdown grace: ten seconds', () => {
    // `SHUTDOWN_TIMEOUT_MS` in src/api/server.ts, which is module-private there and
    // cannot be imported without booting the API process.
    expect(DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS).toBe(10_000);
  });

  it('is far below both the step budget and the lease', () => {
    // Shutdown is not trying to let the step finish — it may have minutes of
    // provider timeout left. It only stops the process waiting forever, which is
    // why the lease release matters: the job is re-claimable immediately instead
    // of after the remaining ~15 minutes.
    expect(DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS).toBeLessThan(MAX_LEGITIMATE_STEP_DURATION_MS);
    expect(DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS).toBeLessThan(DEFAULT_LEASE_MS);
  });
});
