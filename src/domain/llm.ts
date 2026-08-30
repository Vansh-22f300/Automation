/**
 * The LLM provider seam.
 *
 * This module is deliberately vendor-neutral and framework-free: it names the
 * *capabilities* the rest of the system needs from a large language model —
 * text completion, schema-constrained structured output, and normalized usage
 * metadata — without referencing any particular SDK. The execution engine and
 * future workflow steps depend only on `LlmProvider`; a `ClaudeProvider`,
 * `OpenAiProvider`, `GeminiProvider`, or a fake in tests can all satisfy it.
 *
 * What is intentionally NOT modelled here: tool calling, agent loops,
 * multi-turn autonomous behaviour, streaming, and vendor-specific knobs. Those
 * are later steps; adding them now would over-fit the abstraction to one
 * vendor. The interface exposes only what is genuinely required today.
 *
 * The only third-party import is Zod, which the domain already uses pervasively
 * for validation — it is not a framework and carries no I/O.
 */

import type { z } from 'zod';

/** A single conversational turn. Providers map this onto their own wire shape. */
export interface LlmMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * Everything a completion needs and nothing it does not. `model` is optional —
 * when omitted the provider uses its configured default. `timeoutMs`/`signal`
 * give the caller explicit control over cancellation; both are optional and the
 * provider supplies a sensible default timeout.
 *
 * `temperature` is offered because the abstraction is provider-neutral and many
 * models support sampling — but note that the current Claude models reject
 * sampling parameters, so setting it against them surfaces as a permanent
 * invalid-request error rather than being silently ignored.
 */
export interface LlmCompletionRequest {
  /** System instruction, if any. */
  readonly system?: string;
  /** The conversation so far. Must contain at least one message. */
  readonly messages: readonly LlmMessage[];
  /** Overrides the provider's default model for this request. */
  readonly model?: string;
  /** Hard ceiling on tokens the model may generate. */
  readonly maxOutputTokens: number;
  /** Optional sampling temperature (see note above re: current Claude models). */
  readonly temperature?: number;
  /** Per-request timeout override; falls back to the provider's default. */
  readonly timeoutMs?: number;
  /** Cancellation signal, wired through to the underlying transport. */
  readonly signal?: AbortSignal;
}

/** Normalized token accounting, provider-independent. */
export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** The normalized result of a text completion. No raw SDK objects leak out. */
export interface LlmCompletion {
  /** The concatenated text the model produced. */
  readonly text: string;
  /** The model that actually served the request, as reported by the provider. */
  readonly model: string;
  readonly usage: LlmUsage;
  /** Wall-clock latency of the call in milliseconds. */
  readonly latencyMs: number;
  /** Stable provider identifier, e.g. "claude". */
  readonly provider: string;
}

/** A completion whose output is constrained to (and validated against) a schema. */
export interface LlmStructuredRequest<T> extends LlmCompletionRequest {
  /** The Zod schema the model's output must satisfy. */
  readonly schema: z.ZodType<T>;
}

/** The normalized result of a structured completion: typed, validated data. */
export interface LlmStructuredCompletion<T> {
  readonly data: T;
  readonly model: string;
  readonly usage: LlmUsage;
  readonly latencyMs: number;
  readonly provider: string;
}

/**
 * The capability the rest of the system depends on. Implementations own their
 * own transport and configuration; callers hold only this interface.
 *
 * Error contract: implementations map vendor failures onto the shared
 * `RetryableError` / `PermanentError` taxonomy (see src/domain/errors.ts) and
 * classify — they do NOT retry. Deciding whether to retry is the engine's job.
 * A schema-validation failure in `completeStructured` is a `PermanentError`:
 * malformed data must never reach workflow context.
 *
 * Usage metering: a provider returns `usage` on the result and never touches a
 * database. Persisting usage is the caller's responsibility, keeping the
 * provider free of infrastructure concerns.
 */
export interface LlmProvider {
  /** Stable identifier for this provider, e.g. "claude". */
  readonly name: string;
  /** The model used when a request does not specify one. */
  readonly defaultModel: string;

  complete(request: LlmCompletionRequest): Promise<LlmCompletion>;

  completeStructured<T>(request: LlmStructuredRequest<T>): Promise<LlmStructuredCompletion<T>>;
}
