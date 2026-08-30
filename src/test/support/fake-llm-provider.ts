/**
 * A deterministic, in-memory `LlmProvider` for tests.
 *
 * The automated suite must never depend on a live model: it would be slow,
 * costly, non-deterministic, and would fail closed on a missing credential. This
 * fake satisfies the exact `LlmProvider` contract the engine depends on, so a
 * workflow can be driven end-to-end (webhook → run → llm step → structured output
 * → context → next job) without a network call.
 *
 * It does three things a live provider cannot make convenient in a test:
 *   1. **Counts invocations** (`completeStructuredCalls`) so a test can prove the
 *      idempotency guard: a redelivered, already-completed llm step must NOT call
 *      the model again.
 *   2. **Validates against the compiled schema** exactly as a real provider's
 *      structured-output mode does — returning canned `data`, but only after it
 *      passes the caller's Zod schema, so a mismatch surfaces as the same
 *      `PermanentError` a real provider would raise.
 *   3. Lets a test **script a failure** (`failWith`) to exercise the engine's
 *      failure path (step_run failed, run failed, no next job, no retry).
 *
 * It records the last request so a test can assert the trust boundary — that the
 * configured `system` instruction and the resolved user `input` arrive as
 * structurally separate turns, never concatenated.
 */

import { PermanentError } from '@/domain/errors.js';
import type {
  LlmCompletion,
  LlmCompletionRequest,
  LlmProvider,
  LlmStructuredCompletion,
  LlmStructuredRequest,
} from '@/domain/llm.js';

export interface FakeLlmProviderOptions {
  /** Provider identity, mirrors a real provider's `name`. Defaults to "fake". */
  readonly name?: string;
  /** Default model reported when a request omits one. */
  readonly defaultModel?: string;
  /**
   * The data the fake returns from `completeStructured`. It is validated against
   * the request's schema first, so it must satisfy whatever schema the step
   * compiled — the same guarantee a real structured-output provider gives.
   */
  readonly structuredData?: unknown;
  /** Canned usage returned on every call. */
  readonly usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  /** Latency reported on every call. */
  readonly latencyMs?: number;
  /** If set, every call rejects with this error instead of returning. */
  readonly failWith?: Error;
}

export class FakeLlmProvider implements LlmProvider {
  readonly name: string;
  readonly defaultModel: string;

  /** How many times `completeStructured` was invoked — the idempotency probe. */
  completeStructuredCalls = 0;
  /** How many times `complete` was invoked. */
  completeCalls = 0;
  /** The most recent structured request, for trust-boundary assertions. */
  lastStructuredRequest: LlmStructuredRequest<unknown> | undefined;

  private readonly structuredData: unknown;
  private readonly usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  private readonly latencyMs: number;
  private readonly failWith: Error | undefined;

  constructor(options: FakeLlmProviderOptions = {}) {
    this.name = options.name ?? 'fake';
    this.defaultModel = options.defaultModel ?? 'fake-model-1';
    this.structuredData = options.structuredData ?? {};
    this.usage = options.usage ?? { inputTokens: 11, outputTokens: 7, totalTokens: 18 };
    this.latencyMs = options.latencyMs ?? 5;
    this.failWith = options.failWith;
  }

  complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    this.completeCalls += 1;
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    return Promise.resolve({
      text: 'fake completion',
      model: request.model ?? this.defaultModel,
      usage: this.usage,
      latencyMs: this.latencyMs,
      provider: this.name,
    });
  }

  completeStructured<T>(request: LlmStructuredRequest<T>): Promise<LlmStructuredCompletion<T>> {
    this.completeStructuredCalls += 1;
    this.lastStructuredRequest = request as LlmStructuredRequest<unknown>;

    if (this.failWith !== undefined) return Promise.reject(this.failWith);

    // Mirror a real structured-output provider: the returned data must satisfy the
    // schema, or it is a permanent failure — malformed data never reaches context.
    const parsed = request.schema.safeParse(this.structuredData);
    if (!parsed.success) {
      return Promise.reject(
        new PermanentError('llm_structured_output_invalid', 'fake structured output failed schema validation', {
          details: { issues: parsed.error.issues },
        }),
      );
    }

    return Promise.resolve({
      data: parsed.data,
      model: request.model ?? this.defaultModel,
      usage: this.usage,
      latencyMs: this.latencyMs,
      provider: this.name,
    });
  }
}
