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

// ---------------------------------------------------------------------------
// Tool-calling seam (Step 10)
//
// These types let an `llm` step offer the model a bounded set of *platform-
// registered* tools and let the model REQUEST one, without the provider owning
// an agent loop. Everything here is provider-neutral: a `ClaudeProvider`
// translates it to and from the SDK's tool-use/tool-result shapes; nothing else
// imports an SDK. The load-bearing security property lives one layer up in the
// handler — the model only ever sees `{name, description, inputSchema}` and can
// only *request* a tool; it never sees a connection, a tenant, or a credential.
// ---------------------------------------------------------------------------

/**
 * The model-facing view of a tool: exactly what the model may know about it.
 * Deliberately no provider, connection, tenant, or credential — those are
 * trusted platform facts the model must never see or select.
 */
export interface LlmToolDefinition {
  readonly name: string;
  readonly description: string;
  /** The Zod schema the model's arguments must satisfy (authored `.strict()`). */
  readonly inputSchema: z.ZodType;
}

/**
 * A tool the model has requested. `arguments` is untrusted until validated by
 * the executor against the tool's own `inputSchema` — the provider does not
 * validate it. `id` correlates the request with the {@link LlmToolResult} fed back.
 */
export interface LlmToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

/**
 * The safe, normalized outcome of a tool call, fed back to the model. It carries
 * ONLY a connector's non-secret output or a safe `{code, message}` — never a
 * credential, connection metadata, tenant id, encrypted envelope, DB internals,
 * or a raw/internal error object.
 */
export interface LlmToolResult {
  readonly id: string;
  readonly output?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * One neutral turn in a tool conversation. A provider maps these onto its own
 * wire shapes. Note there is no generic "tool" wire role in most vendor APIs —
 * the `'tool'` variant here is a neutral carrier the provider translates (Claude,
 * for instance, folds tool results into a `user` message of `tool_result` blocks).
 */
export type LlmToolMessage =
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly toolCalls: readonly LlmToolCall[] }
  | { readonly role: 'tool'; readonly results: readonly LlmToolResult[] };

/**
 * A single, stateless tool-conversation turn. The bounded loop that decides how
 * many turns to run lives in the caller (the step handler), never in the
 * provider — the provider performs exactly one round-trip per `converse`.
 */
export interface LlmToolTurnRequest {
  readonly system?: string;
  /** The conversation so far. Must contain at least one message. */
  readonly messages: readonly LlmToolMessage[];
  /** The tools the model may request this turn (may be empty). */
  readonly tools: readonly LlmToolDefinition[];
  /** The schema the model's *final* structured output must satisfy. */
  readonly schema: z.ZodType;
  readonly model?: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * The result of one `converse` turn: exactly one of "the model requested tools"
 * or "the model produced its final structured output". A discriminated union so
 * the caller cannot accidentally read `data` on a tool-use turn.
 */
export type LlmToolTurn =
  | {
      readonly kind: 'tool_use';
      readonly toolCalls: readonly LlmToolCall[];
      readonly model: string;
      readonly usage: LlmUsage;
      readonly latencyMs: number;
      readonly provider: string;
    }
  | {
      readonly kind: 'final';
      readonly data: unknown;
      readonly model: string;
      readonly usage: LlmUsage;
      readonly latencyMs: number;
      readonly provider: string;
    };

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

  /**
   * Perform exactly one tool-conversation turn: offer the model the given tools
   * plus the final-output schema, and return either the tools it requested or its
   * final structured data. The caller owns the bounded loop across turns; this
   * method is a single, stateless round-trip and never loops or executes a tool.
   */
  converse(request: LlmToolTurnRequest): Promise<LlmToolTurn>;
}
