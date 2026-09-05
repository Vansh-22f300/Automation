export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId?: string;
  };
}

export interface SafeError {
  readonly code: string;
  readonly message: string;
}

export interface ValueSummary {
  readonly byteSize: number;
  readonly preview: string;
}

export interface RunInspection {
  readonly run: {
    readonly id: string;
    readonly status: string;
    readonly currentStepKey: string | null;
    readonly createdAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly error: SafeError | null;
    readonly contextSummary: ValueSummary;
  };
  readonly workflow: {
    readonly id: string;
    readonly name: string;
    readonly status: string;
  };
  readonly version: {
    readonly id: string;
    readonly version: number;
    readonly triggerType: string;
  };
  readonly event: {
    readonly id: string;
    readonly source: string;
    readonly receivedAt: string;
    readonly payloadSummary: ValueSummary;
  };
  readonly steps: readonly StepRun[];
  readonly jobs: readonly Job[];
  readonly llmUsage: readonly LlmUsage[];
  readonly tools: readonly ToolActivity[];
  readonly usageTotals: UsageTotals;
}

export interface StepRun {
  readonly id: string;
  readonly stepKey: string;
  readonly stepType: string;
  readonly attempt: number;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly error: SafeError | null;
  readonly inputSummary: ValueSummary;
  readonly outputSummary: ValueSummary;
}

export interface Job {
  readonly id: string;
  readonly stepKey: string;
  readonly status: string;
  readonly attempt: number;
  readonly retryCount: number;
  readonly maxAttempts: number;
  readonly runAt: string;
  readonly createdAt: string;
  readonly leased: boolean;
  readonly lastError: SafeError | null;
}

export interface LlmUsage {
  readonly stepKey: string | null;
  readonly round: number;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly latencyMs: number;
}

export interface ToolActivity {
  readonly stepKey: string;
  readonly rounds: number;
  readonly usedTools: boolean;
  readonly toolRounds: number;
}

export interface UsageTotals {
  readonly rounds: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly latencyMs: number;
}

export interface HealthStatus {
  readonly status: string;
}
