/**
 * Unit tests for the pure run-inspection assembler — no database.
 *
 * These prove the shaping and redaction contract the CLI and API both inherit:
 * dates become ISO strings; values are summarized by default and only attached
 * raw in detail mode; the three job counters stay distinct; `leased` reflects an
 * unexpired running lease; llm usage is attributed to step keys and ordered; and
 * tool activity is reconstructed from round counts.
 */

import { describe, expect, it } from 'vitest';

import type { Event, Job, LlmUsage, ToolEffect, Workflow, WorkflowRun, WorkflowStepRun, WorkflowVersion } from '@/db/schema.js';
import { assembleRunInspection } from '@/domain/run-inspection.js';
import type { RawRunData } from '@/domain/run-inspection.js';

const T = (ms: number): Date => new Date(ms);

const run = (over: Partial<WorkflowRun> = {}): WorkflowRun =>
  ({
    id: 'run-1',
    tenantId: 'tenant-1',
    workflowId: 'wf-1',
    workflowVersionId: 'ver-1',
    eventId: 'ev-1',
    status: 'succeeded',
    currentStepKey: 'a',
    context: { steps: { a: { ok: true } } },
    error: null,
    createdAt: T(1_000),
    startedAt: T(1_100),
    finishedAt: T(1_200),
    ...over,
  }) as WorkflowRun;

const workflow: Workflow = {
  id: 'wf-1',
  tenantId: 'tenant-1',
  name: 'My Workflow',
  status: 'active',
  createdAt: T(0),
  updatedAt: T(0),
} as Workflow;

const version: WorkflowVersion = {
  id: 'ver-1',
  tenantId: 'tenant-1',
  workflowId: 'wf-1',
  version: 3,
  definition: {},
  triggerType: 'webhook',
  triggerConfig: { source: 'stripe', secret_ref: 'do-not-leak' },
  isActive: true,
  createdAt: T(0),
} as WorkflowVersion;

const event: Event = {
  id: 'ev-1',
  tenantId: 'tenant-1',
  source: 'stripe',
  dedupeKey: 'abc',
  payload: { hello: 'world' },
  receivedAt: T(500),
} as Event;

const stepRun = (over: Partial<WorkflowStepRun> = {}): WorkflowStepRun =>
  ({
    id: 'sr-1',
    tenantId: 'tenant-1',
    runId: 'run-1',
    stepKey: 'a',
    stepType: 'noop',
    attempt: 0,
    status: 'succeeded',
    input: null,
    output: { ok: true },
    error: null,
    startedAt: T(1_100),
    finishedAt: T(1_150),
    durationMs: 50,
    ...over,
  }) as WorkflowStepRun;

const job = (over: Partial<Job> = {}): Job =>
  ({
    id: 'job-1',
    tenantId: 'tenant-1',
    runId: 'run-1',
    stepKey: 'a',
    attempt: 0,
    retryCount: 0,
    maxAttempts: 5,
    status: 'done',
    runAt: T(1_000),
    lockedBy: null,
    leaseExpiresAt: null,
    lastError: null,
    createdAt: T(1_000),
    updatedAt: T(1_000),
    ...over,
  }) as Job;

const usage = (over: Partial<LlmUsage> = {}): LlmUsage =>
  ({
    id: 'u-1',
    tenantId: 'tenant-1',
    runId: 'run-1',
    stepRunId: 'sr-1',
    provider: 'claude',
    model: 'claude-opus-5',
    round: 1,
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    latencyMs: 100,
    createdAt: T(1_100),
    ...over,
  }) as LlmUsage;

// Seeded with values that MUST NOT cross the inspection boundary — the idempotency
// key, the owner/lease tokens, the stored result, and an error carrying a `details`
// payload — so the safe-fields test can prove each is absent from the DTO.
const toolEffect = (over: Partial<ToolEffect> = {}): ToolEffect =>
  ({
    id: 'te-1',
    tenantId: 'tenant-1',
    runId: 'run-1',
    stepKey: 'a',
    toolName: 'send_slack_message',
    ordinal: 1,
    idempotencyKey: 'run-1:a:send_slack_message:1',
    provider: 'slack',
    state: 'succeeded',
    owner: 'sr-1',
    leaseExpiresAt: null,
    result: { channel: 'C123', ts: '1700000000.000100' },
    error: null,
    createdAt: T(1_120),
    updatedAt: T(1_130),
    ...over,
  }) as ToolEffect;

const base = (over: Partial<RawRunData> = {}): RawRunData => ({
  run: run(),
  workflow,
  version,
  event,
  steps: [stepRun()],
  jobs: [job()],
  llmUsage: [],
  ...over,
});

describe('assembleRunInspection — shaping', () => {
  it('maps identity, ISO dates and never exposes trigger_config', () => {
    const view = assembleRunInspection(base(), { detail: false, now: 2_000 });
    expect(view.run.id).toBe('run-1');
    expect(view.run.createdAt).toBe(T(1_000).toISOString());
    expect(view.run.finishedAt).toBe(T(1_200).toISOString());
    expect(view.version.version).toBe(3);
    // The VersionRefDto has no field carrying trigger_config at all.
    expect(JSON.stringify(view)).not.toContain('do-not-leak');
  });

  it('summarizes by default and omits raw values', () => {
    const view = assembleRunInspection(base(), { detail: false, now: 2_000 });
    expect(view.run.contextSummary.bytes).toBeGreaterThan(0);
    expect(view.run.context).toBeUndefined();
    expect(view.event.payload).toBeUndefined();
    expect(view.steps[0]!.output).toBeUndefined();
  });

  it('attaches secret-scrubbed raw values in detail mode', () => {
    const view = assembleRunInspection(
      base({ event: { ...event, payload: { token: 'sekret' } } as Event }),
      { detail: true, now: 2_000 },
    );
    expect(view.run.context).toEqual({ steps: { a: { ok: true } } });
    expect(JSON.stringify(view.event.payload)).toContain('«redacted:secret-key»');
    expect(JSON.stringify(view.event.payload)).not.toContain('sekret');
  });
});

describe('assembleRunInspection — jobs', () => {
  it('keeps attempt, retryCount and maxAttempts distinct', () => {
    const view = assembleRunInspection(
      base({ jobs: [job({ attempt: 2, retryCount: 1, maxAttempts: 5 })] }),
      { detail: false, now: 2_000 },
    );
    const j = view.jobs[0]!;
    expect(j.attempt).toBe(2);
    expect(j.retryCount).toBe(1);
    expect(j.maxAttempts).toBe(5);
  });

  it('reports leased=true only for a running job with an unexpired lease', () => {
    const running = job({ status: 'running', lockedBy: 'w1', leaseExpiresAt: T(3_000) });
    const expired = job({ status: 'running', lockedBy: 'w1', leaseExpiresAt: T(1_500) });
    expect(assembleRunInspection(base({ jobs: [running] }), { detail: false, now: 2_000 }).jobs[0]!.leased).toBe(true);
    expect(assembleRunInspection(base({ jobs: [expired] }), { detail: false, now: 2_000 }).jobs[0]!.leased).toBe(false);
    // Never exposes the worker id.
    expect(JSON.stringify(assembleRunInspection(base({ jobs: [running] }), { detail: false, now: 2_000 }))).not.toContain('w1');
  });
});

describe('assembleRunInspection — usage and tools', () => {
  it('attributes usage to step keys and orders by step then round', () => {
    const steps = [
      stepRun({ id: 'sr-1', stepKey: 'a', startedAt: T(1_100) }),
      stepRun({ id: 'sr-2', stepKey: 'b', startedAt: T(1_300) }),
    ];
    const llm = [
      usage({ id: 'u2', stepRunId: 'sr-2', round: 1 }),
      usage({ id: 'u1b', stepRunId: 'sr-1', round: 2 }),
      usage({ id: 'u1a', stepRunId: 'sr-1', round: 1 }),
    ];
    const view = assembleRunInspection(base({ steps, llmUsage: llm }), { detail: false, now: 2_000 });
    expect(view.llmUsage.map((u) => [u.stepKey, u.round])).toEqual([
      ['a', 1],
      ['a', 2],
      ['b', 1],
    ]);
  });

  it('reconstructs tool usage from round counts', () => {
    const steps = [
      stepRun({ id: 'sr-1', stepKey: 'a' }),
      stepRun({ id: 'sr-2', stepKey: 'b' }),
    ];
    const llm = [
      usage({ id: 'u1', stepRunId: 'sr-1', round: 1 }),
      usage({ id: 'u2', stepRunId: 'sr-2', round: 1 }),
      usage({ id: 'u3', stepRunId: 'sr-2', round: 2 }),
    ];
    const view = assembleRunInspection(base({ steps, llmUsage: llm }), { detail: false, now: 2_000 });
    expect(view.tools).toEqual([
      { stepKey: 'a', rounds: 1, usedTools: false, toolRounds: 0 },
      { stepKey: 'b', rounds: 2, usedTools: true, toolRounds: 1 },
    ]);
    expect(view.usageTotals).toEqual({
      rounds: 3,
      inputTokens: 30,
      outputTokens: 60,
      totalTokens: 90,
      latencyMs: 300,
    });
  });
});

describe('assembleRunInspection — run error', () => {
  it('maps a failed run error to the safe shape', () => {
    const view = assembleRunInspection(
      base({ run: run({ status: 'failed', error: { code: 'boom', message: 'nope', details: { x: 1 } } }) }),
      { detail: false, now: 2_000 },
    );
    expect(view.run.error).toEqual({ code: 'boom', message: 'nope' });
  });
});

describe('assembleRunInspection — tool effects', () => {
  it('shapes ledger rows into the DTO in detail mode: state, tool, ordinal, provider', () => {
    const view = assembleRunInspection(
      base({ toolEffects: [toolEffect()] }),
      { detail: true, now: 2_000 },
    );
    expect(view.toolEffects).toEqual([
      {
        stepKey: 'a',
        toolName: 'send_slack_message',
        ordinal: 1,
        provider: 'slack',
        state: 'succeeded',
        ambiguous: false,
        error: null,
      },
    ]);
  });

  it('omits tool effects entirely on the summary (non-detail) surface', () => {
    const view = assembleRunInspection(
      base({ toolEffects: [toolEffect()] }),
      { detail: false, now: 2_000 },
    );
    expect(view.toolEffects).toBeUndefined();
  });

  it('exposes only safe fields — never the idempotency key, owner, lease, result, or error details', () => {
    const view = assembleRunInspection(
      base({
        toolEffects: [
          toolEffect({
            state: 'ambiguous',
            error: {
              code: 'effect_ambiguous',
              message: 'crashed mid-send',
              details: { token: 'xoxb-do-not-leak', channel: 'C-secret' },
            },
          }),
        ],
      }),
      { detail: true, now: 2_000 },
    );
    const effect = view.toolEffects![0]!;
    // Only the seven safe keys, nothing else.
    expect(Object.keys(effect).sort()).toEqual(
      ['ambiguous', 'error', 'ordinal', 'provider', 'state', 'stepKey', 'toolName'].sort(),
    );
    // toSafeError keeps {code, message}; it drops the details payload.
    expect(effect.error).toEqual({ code: 'effect_ambiguous', message: 'crashed mid-send' });
    const serialized = JSON.stringify(view.toolEffects);
    expect(serialized).not.toContain('run-1:a:send_slack_message'); // idempotency key
    expect(serialized).not.toContain('xoxb-do-not-leak'); // error details / secret
    expect(serialized).not.toContain('C-secret'); // error details
    expect(serialized).not.toContain('1700000000.000100'); // stored result ts
    expect(serialized).not.toContain('sr-1'); // owner (step-run id token)
  });

  it('represents an ambiguous effect distinctly from a plain failure', () => {
    const view = assembleRunInspection(
      base({
        steps: [
          stepRun({ id: 'sr-1', stepKey: 'a', startedAt: T(1_100) }),
          stepRun({ id: 'sr-2', stepKey: 'b', startedAt: T(1_300) }),
        ],
        toolEffects: [
          // Out of execution order on input; expected sorted by step order then ordinal.
          toolEffect({ id: 'te-b', stepKey: 'b', ordinal: 1, state: 'failed', error: { code: 'http_500', message: 'bad gateway' } }),
          toolEffect({ id: 'te-a2', stepKey: 'a', ordinal: 2, state: 'ambiguous', error: { code: 'effect_ambiguous', message: 'unknown' } }),
          toolEffect({ id: 'te-a1', stepKey: 'a', ordinal: 1, state: 'succeeded' }),
        ],
      }),
      { detail: true, now: 2_000 },
    );
    expect(view.toolEffects!.map((e) => [e.stepKey, e.ordinal, e.state, e.ambiguous])).toEqual([
      ['a', 1, 'succeeded', false],
      ['a', 2, 'ambiguous', true],
      ['b', 1, 'failed', false],
    ]);
    // `ambiguous` is a distinct boolean, not conflated with the `failed` state.
    const failed = view.toolEffects!.find((e) => e.state === 'failed')!;
    expect(failed.ambiguous).toBe(false);
    const ambiguous = view.toolEffects!.find((e) => e.state === 'ambiguous')!;
    expect(ambiguous.ambiguous).toBe(true);
  });
});
