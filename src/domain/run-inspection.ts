/**
 * The run-inspection read model: one coherent, safe-by-default view of a single
 * workflow run, assembled from the several tables that record its execution.
 *
 * This module is PURE. It never touches the database or Fastify; it takes the raw
 * rows a repository has already fetched (tenant-scoped) and folds them into a
 * `RunInspection` DTO tree. That tree — never a raw DB row — is what both the CLI
 * and the `GET /v1/runs/:runId` endpoint return, so the redaction and shaping
 * rules live in exactly one place and cannot drift between the two surfaces.
 *
 * Safe-by-default: every possibly-large, possibly-sensitive value (the run
 * context, the event payload, each step's input/output) is rendered as a
 * `ValueSummary` (size + redacted, capped preview). The raw, secret-scrubbed value
 * is attached ONLY when `detail` is requested — a mode the CLI exposes behind
 * `--detail` and the API deliberately does not offer yet.
 *
 * Tool activity is not stored in a table of its own; it is reconstructed from
 * `llm_usage` round counts — a step run with more than one metered round used
 * tools. Per-call tool names and arguments live only in logs, never here.
 */

import type {
  Event,
  Job,
  LlmUsage,
  Workflow,
  WorkflowRun,
  WorkflowStepRun,
  WorkflowVersion,
} from '@/db/schema.js';
import { redactDeep, summarizeValue, toSafeError } from '@/domain/redaction.js';
import type { SafeErrorDto, ValueSummary } from '@/domain/redaction.js';

/** The run itself: status, timing, and a safe view of its accumulated context. */
export interface RunDto {
  readonly id: string;
  readonly tenantId: string;
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly eventId: string;
  readonly status: string;
  readonly currentStepKey: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** The run-level failure, mapped to the client-safe shape. Null unless failed. */
  readonly error: SafeErrorDto | null;
  /** Safe-by-default summary of the accumulated run context. Always present. */
  readonly contextSummary: ValueSummary;
  /** The secret-scrubbed raw context. Present only in detail mode. */
  readonly context?: unknown;
}

/** The workflow this run belongs to — identity only, no logic. */
export interface WorkflowRefDto {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

/** The exact pinned version the run executed. Never "the current active" one. */
export interface VersionRefDto {
  readonly id: string;
  readonly version: number;
  readonly triggerType: string;
}

/** The triggering event, with its payload rendered safely. `trigger_config` is never exposed. */
export interface EventRefDto {
  readonly id: string;
  readonly source: string;
  readonly receivedAt: string;
  readonly payloadSummary: ValueSummary;
  /** The secret-scrubbed raw payload. Present only in detail mode. */
  readonly payload?: unknown;
}

/** One step execution (one attempt), with input/output rendered safely. */
export interface StepRunDto {
  readonly id: string;
  readonly stepKey: string;
  readonly stepType: string;
  readonly attempt: number;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly error: SafeErrorDto | null;
  readonly inputSummary: ValueSummary;
  readonly outputSummary: ValueSummary;
  /** Secret-scrubbed raw input/output. Present only in detail mode. */
  readonly input?: unknown;
  readonly output?: unknown;
}

/**
 * A queued unit of work for this run. `leased` replaces the raw `locked_by`
 * worker id (an internal detail an operator does not need); `attempt`,
 * `retryCount` and `maxAttempts` stay distinct — a crash count, a business-retry
 * count, and the retry budget are three different things.
 */
export interface JobDto {
  readonly id: string;
  readonly stepKey: string;
  readonly status: string;
  readonly attempt: number;
  readonly retryCount: number;
  readonly maxAttempts: number;
  readonly runAt: string;
  readonly createdAt: string;
  /** True when the job is `running` under an unexpired lease. Never the worker id. */
  readonly leased: boolean;
  readonly lastError: SafeErrorDto | null;
}

/** One metered provider round for an `llm` step, tied back to its step key. */
export interface LlmUsageDto {
  readonly stepKey: string | null;
  readonly round: number;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly latencyMs: number;
}

/**
 * Reconstructed tool activity for one `llm` step run. Not a stored fact: derived
 * from the round count, since a tool-calling step meters each round separately
 * (round 1 is the initial call; each extra round followed a tool execution).
 */
export interface ToolActivityDto {
  readonly stepKey: string;
  readonly rounds: number;
  readonly usedTools: boolean;
  /** Number of tool-execution rounds (rounds beyond the first). */
  readonly toolRounds: number;
}

/** Token/latency totals across every metered round of the run. */
export interface UsageTotalsDto {
  readonly rounds: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly latencyMs: number;
}

/** The whole coherent view of one run. The single shape CLI and API both return. */
export interface RunInspection {
  readonly run: RunDto;
  readonly workflow: WorkflowRefDto;
  readonly version: VersionRefDto;
  readonly event: EventRefDto;
  readonly steps: readonly StepRunDto[];
  readonly jobs: readonly JobDto[];
  readonly llmUsage: readonly LlmUsageDto[];
  readonly tools: readonly ToolActivityDto[];
  readonly usageTotals: UsageTotalsDto;
}

/** The raw, already-tenant-scoped rows the repository fetched for one run. */
export interface RawRunData {
  readonly run: WorkflowRun;
  readonly workflow: Workflow;
  readonly version: WorkflowVersion;
  readonly event: Event;
  readonly steps: readonly WorkflowStepRun[];
  readonly jobs: readonly Job[];
  readonly llmUsage: readonly LlmUsage[];
}

/** Assembly options: whether to attach raw detail, and "now" for lease liveness. */
export interface AssembleOptions {
  /** Attach secret-scrubbed raw values (context/payload/input/output). */
  readonly detail: boolean;
  /** Epoch ms used to decide whether a running job's lease is still live. */
  readonly now: number;
}

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

/**
 * Fold the raw rows into the coherent, safe view. Pure and total: given the same
 * rows and options it always returns the same DTO, and it never throws on shape.
 */
export function assembleRunInspection(data: RawRunData, options: AssembleOptions): RunInspection {
  const { detail, now } = options;

  const run: RunDto = {
    id: data.run.id,
    tenantId: data.run.tenantId,
    workflowId: data.run.workflowId,
    workflowVersionId: data.run.workflowVersionId,
    eventId: data.run.eventId,
    status: data.run.status,
    currentStepKey: data.run.currentStepKey,
    createdAt: data.run.createdAt.toISOString(),
    startedAt: iso(data.run.startedAt),
    finishedAt: iso(data.run.finishedAt),
    error: toSafeError(data.run.error),
    contextSummary: summarizeValue(data.run.context),
    ...(detail ? { context: redactDeep(data.run.context) } : {}),
  };

  const workflow: WorkflowRefDto = {
    id: data.workflow.id,
    name: data.workflow.name,
    status: data.workflow.status,
  };

  const version: VersionRefDto = {
    id: data.version.id,
    version: data.version.version,
    triggerType: data.version.triggerType,
  };

  const event: EventRefDto = {
    id: data.event.id,
    source: data.event.source,
    receivedAt: data.event.receivedAt.toISOString(),
    payloadSummary: summarizeValue(data.event.payload),
    ...(detail ? { payload: redactDeep(data.event.payload) } : {}),
  };

  // Step runs in execution order. Also the source of the stepRunId → stepKey map
  // used to attribute llm usage and tool activity below.
  const orderedSteps = [...data.steps].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );
  const stepKeyByRunId = new Map<string, string>();
  const steps: StepRunDto[] = orderedSteps.map((s) => {
    stepKeyByRunId.set(s.id, s.stepKey);
    return {
      id: s.id,
      stepKey: s.stepKey,
      stepType: s.stepType,
      attempt: s.attempt,
      status: s.status,
      startedAt: s.startedAt.toISOString(),
      finishedAt: iso(s.finishedAt),
      durationMs: s.durationMs,
      error: toSafeError(s.error),
      inputSummary: summarizeValue(s.input ?? null),
      outputSummary: summarizeValue(s.output ?? null),
      ...(detail ? { input: redactDeep(s.input ?? null), output: redactDeep(s.output ?? null) } : {}),
    };
  });

  // Jobs oldest-first; the raw worker id (`locked_by`) is collapsed to a boolean.
  const orderedJobs = [...data.jobs].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const jobs: JobDto[] = orderedJobs.map((j) => ({
    id: j.id,
    stepKey: j.stepKey,
    status: j.status,
    attempt: j.attempt,
    retryCount: j.retryCount,
    maxAttempts: j.maxAttempts,
    runAt: j.runAt.toISOString(),
    createdAt: j.createdAt.toISOString(),
    leased:
      j.status === 'running' &&
      j.leaseExpiresAt !== null &&
      j.leaseExpiresAt.getTime() > now,
    lastError: toSafeError(j.lastError),
  }));

  // Usage ordered by step (execution order) then round. Rows whose step run is
  // not among this run's steps (should not happen) sort last with a null key.
  const stepOrderIndex = new Map<string, number>();
  orderedSteps.forEach((s, i) => stepOrderIndex.set(s.id, i));
  const orderedUsage = [...data.llmUsage].sort((a, b) => {
    const ai = stepOrderIndex.get(a.stepRunId) ?? Number.MAX_SAFE_INTEGER;
    const bi = stepOrderIndex.get(b.stepRunId) ?? Number.MAX_SAFE_INTEGER;
    return ai === bi ? a.round - b.round : ai - bi;
  });
  const llmUsageDtos: LlmUsageDto[] = orderedUsage.map((u) => ({
    stepKey: stepKeyByRunId.get(u.stepRunId) ?? null,
    round: u.round,
    provider: u.provider,
    model: u.model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.totalTokens,
    latencyMs: u.latencyMs,
  }));

  // Tool activity, reconstructed per step run from its round count.
  const roundsByStepRun = new Map<string, number>();
  for (const u of data.llmUsage) {
    roundsByStepRun.set(u.stepRunId, (roundsByStepRun.get(u.stepRunId) ?? 0) + 1);
  }
  const tools: ToolActivityDto[] = orderedSteps
    .filter((s) => roundsByStepRun.has(s.id))
    .map((s) => {
      const rounds = roundsByStepRun.get(s.id) ?? 0;
      return {
        stepKey: s.stepKey,
        rounds,
        usedTools: rounds > 1,
        toolRounds: Math.max(0, rounds - 1),
      };
    });

  const usageTotals: UsageTotalsDto = data.llmUsage.reduce<UsageTotalsDto>(
    (acc, u) => ({
      rounds: acc.rounds + 1,
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      totalTokens: acc.totalTokens + u.totalTokens,
      latencyMs: acc.latencyMs + u.latencyMs,
    }),
    { rounds: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 0 },
  );

  return { run, workflow, version, event, steps, jobs, llmUsage: llmUsageDtos, tools, usageTotals };
}
