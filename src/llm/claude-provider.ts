/**
 * The Claude implementation of `LlmProvider`.
 *
 * This is the single place in the system that knows about `@anthropic-ai/sdk`.
 * It owns one SDK client, translates our vendor-neutral request/response shapes
 * to and from the SDK's, maps the SDK's typed errors onto our retryable/permanent
 * taxonomy, and normalizes usage — so nothing else has to import the SDK or
 * reason about its error classes.
 *
 * Design choices worth stating:
 * - Configuration arrives via the constructor; the provider never reads
 *   `process.env` itself. `createClaudeProvider` is the one bridge from `Env`.
 * - A credential — an API key (`x-api-key`) or a bearer token (`Authorization`)
 *   — is required to construct a provider (fail clearly, early), and configuring
 *   both is refused. An optional `baseURL` points the same provider at an
 *   Anthropic-compatible gateway. The *application* still boots without any of
 *   this because nothing constructs a provider until a Claude call is needed.
 * - The SDK's own retry loop is disabled (`maxRetries: 0`). Step 7 classifies
 *   failures; deciding whether to retry belongs to the engine (Step 11).
 * - Errors are mapped by SDK *class*, never by string-matching messages. Raw SDK
 *   errors are never re-thrown to callers, so credentials and payloads in them
 *   cannot leak upward; only a normalized `AppError` with redacted details escapes.
 * - Logs at this boundary carry metadata only — provider, model, latency, token
 *   counts, outcome. Never the API key, the prompt, or the response body.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import type { Env } from '@/config/env.js';
import { AppError, PermanentError, RetryableError, isAppError } from '@/domain/errors.js';
import type {
  LlmCompletion,
  LlmCompletionRequest,
  LlmMessage,
  LlmProvider,
  LlmStructuredCompletion,
  LlmStructuredRequest,
  LlmToolCall,
  LlmToolDefinition,
  LlmToolMessage,
  LlmToolTurn,
  LlmToolTurnRequest,
  LlmUsage,
} from '@/domain/llm.js';
import type { Logger } from '@/observability/logger.js';

/** Stable identifier reported on every result and log line. */
const PROVIDER_NAME = 'claude';

/** Default per-request timeout when neither the request nor the config sets one. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface ClaudeProviderConfig {
  /**
   * The Anthropic API key, sent as `x-api-key`. Mutually exclusive with
   * `authToken`. Exactly one of the two must resolve to a non-empty value
   * (unless an SDK `client` is injected, as in tests).
   */
  readonly apiKey?: string;
  /**
   * A bearer token for an Anthropic-compatible gateway, sent as
   * `Authorization: Bearer <token>`. Mutually exclusive with `apiKey`.
   */
  readonly authToken?: string;
  /**
   * Base URL of the Anthropic-compatible endpoint. Omitted → the SDK default
   * (`https://api.anthropic.com`). The SDK appends `/v1/messages`, so this must
   * not itself end in `/v1`.
   */
  readonly baseURL?: string;
  /** The model used when a request does not name one. */
  readonly model: string;
  /** Logger for the provider boundary. Callers may pre-bind correlation ids. */
  readonly logger: Logger;
  /** Overrides the default per-request timeout. */
  readonly defaultTimeoutMs?: number;
  /**
   * An injected SDK client. Production omits this and the provider builds its
   * own; tests pass a client with stubbed `messages.create` / `messages.parse`
   * so no unit test ever touches the network.
   */
  readonly client?: Anthropic;
}

/** Trim to a defined non-empty string, or `undefined`. */
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : value;
}

export class ClaudeProvider implements LlmProvider {
  readonly name = PROVIDER_NAME;

  private readonly model: string;
  private readonly logger: Logger;
  private readonly defaultTimeoutMs: number;
  private readonly client: Anthropic;

  constructor(config: ClaudeProviderConfig) {
    const apiKey = nonEmpty(config.apiKey);
    const authToken = nonEmpty(config.authToken);

    // Two auth methods at once is ambiguous; refuse rather than guess.
    if (apiKey !== undefined && authToken !== undefined) {
      throw new PermanentError(
        'llm_ambiguous_credentials',
        'both an API key and an auth token were provided; configure exactly one',
        { details: { provider: PROVIDER_NAME } },
      );
    }

    this.model = config.model;
    this.logger = config.logger;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (config.client !== undefined) {
      this.client = config.client;
      return;
    }

    if (apiKey === undefined && authToken === undefined) {
      throw new PermanentError(
        'llm_missing_api_key',
        'a Claude API key (x-api-key) or auth token (bearer) is required to construct ClaudeProvider',
        { details: { provider: PROVIDER_NAME } },
      );
    }

    // Pin the chosen method and null the other, so an ambient ANTHROPIC_API_KEY /
    // ANTHROPIC_AUTH_TOKEN in the environment can never smuggle in a second header.
    this.client = new Anthropic({
      ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
      apiKey: apiKey ?? null,
      authToken: authToken ?? null,
      // We classify and let the engine decide on retries (Step 11); the SDK
      // must not silently retry underneath us.
      maxRetries: 0,
      timeout: this.defaultTimeoutMs,
    });
  }

  get defaultModel(): string {
    return this.model;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    const model = request.model ?? this.model;
    const started = performance.now();
    try {
      this.assertHasMessages(request.messages);
      const response = await this.client.messages.create(
        {
          model,
          max_tokens: request.maxOutputTokens,
          messages: this.toSdkMessages(request.messages),
          ...(request.system !== undefined ? { system: request.system } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        },
        this.requestOptions(request),
      );

      const latencyMs = elapsed(started);
      this.assertNotRefusal(response.stop_reason, model);

      const completion: LlmCompletion = {
        text: extractText(response.content),
        model: response.model,
        usage: toUsage(response.usage),
        latencyMs,
        provider: PROVIDER_NAME,
      };
      this.logSuccess(model, completion.usage, latencyMs);
      return completion;
    } catch (error) {
      throw this.handle(error, model, started);
    }
  }

  async completeStructured<T>(
    request: LlmStructuredRequest<T>,
  ): Promise<LlmStructuredCompletion<T>> {
    const model = request.model ?? this.model;
    const started = performance.now();
    try {
      this.assertHasMessages(request.messages);
      const response = await this.client.messages.parse(
        {
          model,
          max_tokens: request.maxOutputTokens,
          messages: this.toSdkMessages(request.messages),
          output_config: { format: zodOutputFormat(request.schema) },
          ...(request.system !== undefined ? { system: request.system } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        },
        this.requestOptions(request),
      );

      const latencyMs = elapsed(started);
      this.assertNotRefusal(response.stop_reason, model);

      // Defensive re-validation. `parse()` already validates, but we never let
      // unvalidated data escape this boundary into workflow context — a mismatch
      // (or a null parse) is a permanent failure, not a silent malformed result.
      const parsed = request.schema.safeParse(response.parsed_output);
      if (!parsed.success) {
        throw new PermanentError(
          'llm_structured_parse_failed',
          'Claude structured output did not match the requested schema',
          { details: { provider: PROVIDER_NAME, model } },
        );
      }

      const completion: LlmStructuredCompletion<T> = {
        data: parsed.data,
        model: response.model,
        usage: toUsage(response.usage),
        latencyMs,
        provider: PROVIDER_NAME,
      };
      this.logSuccess(model, completion.usage, latencyMs);
      return completion;
    } catch (error) {
      throw this.handle(error, model, started);
    }
  }

  /**
   * One stateless tool-conversation turn. Offers the model the given tools plus
   * the final-output schema and returns either the tools it requested or its
   * final structured data. The bounded loop lives in the caller; this performs a
   * single round-trip and never executes a tool or loops. `messages.parse`
   * accepts `tools` and `output_config` together, so one call covers both the
   * "requested a tool" and "produced final output" outcomes.
   */
  async converse(request: LlmToolTurnRequest): Promise<LlmToolTurn> {
    const model = request.model ?? this.model;
    const started = performance.now();
    try {
      if (request.messages.length === 0) {
        throw new PermanentError('llm_invalid_request', 'at least one message is required', {
          details: { provider: PROVIDER_NAME },
        });
      }

      const response = await this.client.messages.parse(
        {
          model,
          max_tokens: request.maxOutputTokens,
          messages: toSdkToolMessages(request.messages),
          output_config: { format: zodOutputFormat(request.schema) },
          ...(request.tools.length > 0
            ? { tools: toSdkTools(request.tools), tool_choice: { type: 'auto' as const } }
            : {}),
          ...(request.system !== undefined ? { system: request.system } : {}),
        },
        {
          maxRetries: 0,
          timeout: request.timeoutMs ?? this.defaultTimeoutMs,
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        },
      );

      const latencyMs = elapsed(started);
      this.assertNotRefusal(response.stop_reason, model);
      const usage = toUsage(response.usage);

      // The model requested one or more tools: surface them for the caller to
      // execute. We do NOT validate arguments here — the executor does, against
      // the tool's own strict schema.
      if (response.stop_reason === 'tool_use') {
        const toolCalls = extractToolCalls(response.content);
        if (toolCalls.length === 0) {
          // stop_reason said tool_use but no tool_use block was present — a
          // malformed turn we refuse rather than loop on.
          throw new PermanentError(
            'llm_tool_call_malformed',
            'Claude signalled a tool use but produced no tool_use block',
            { details: { provider: PROVIDER_NAME, model } },
          );
        }
        this.logSuccess(model, usage, latencyMs);
        return { kind: 'tool_use', toolCalls, model: response.model, usage, latencyMs, provider: PROVIDER_NAME };
      }

      // Otherwise the model produced its final answer. Defensively re-validate —
      // unvalidated data must never escape this boundary into workflow context.
      const parsed = request.schema.safeParse(response.parsed_output);
      if (!parsed.success) {
        throw new PermanentError(
          'llm_structured_parse_failed',
          'Claude structured output did not match the requested schema',
          { details: { provider: PROVIDER_NAME, model } },
        );
      }
      this.logSuccess(model, usage, latencyMs);
      return { kind: 'final', data: parsed.data, model: response.model, usage, latencyMs, provider: PROVIDER_NAME };
    } catch (error) {
      throw this.handle(error, model, started);
    }
  }

  /** Rejects an empty conversation before spending an API round-trip on it. */
  private assertHasMessages(messages: readonly LlmMessage[]): void {
    if (messages.length === 0) {
      throw new PermanentError('llm_invalid_request', 'at least one message is required', {
        details: { provider: PROVIDER_NAME },
      });
    }
  }

  private assertNotRefusal(stopReason: string | null, model: string): void {
    if (stopReason === 'refusal') {
      throw new PermanentError('llm_refused', 'Claude declined to answer the request', {
        details: { provider: PROVIDER_NAME, model },
      });
    }
  }

  private toSdkMessages(messages: readonly LlmMessage[]): Anthropic.MessageParam[] {
    return messages.map((m) => ({ role: m.role, content: m.content }));
  }

  private requestOptions(request: LlmCompletionRequest): Anthropic.RequestOptions {
    const options: Anthropic.RequestOptions = {
      maxRetries: 0,
      timeout: request.timeoutMs ?? this.defaultTimeoutMs,
    };
    if (request.signal !== undefined) {
      options.signal = request.signal;
    }
    return options;
  }

  /** Normalize, log, and rethrow any failure as an `AppError`. */
  private handle(error: unknown, model: string, started: number): AppError {
    const appError = isAppError(error) ? error : this.toAppError(error, model);
    this.logger.warn(
      { provider: PROVIDER_NAME, model, latency_ms: elapsed(started), err_code: appError.code },
      'llm request failed',
    );
    return appError;
  }

  private logSuccess(model: string, usage: LlmUsage, latencyMs: number): void {
    this.logger.info(
      {
        provider: PROVIDER_NAME,
        model,
        latency_ms: latencyMs,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
      },
      'llm request succeeded',
    );
  }

  /**
   * Map an SDK error onto our taxonomy — by class, never by message string.
   *
   * Retryable: network failure, timeout, abort, 429, and transient 5xx/408.
   * Permanent: bad key, forbidden, invalid request, unknown model, and any other
   * classified client error. Crucially, an *unrecognised* error is Permanent:
   * an unknown failure must never accidentally become retryable.
   */
  private toAppError(error: unknown, model: string): AppError {
    const details = { provider: PROVIDER_NAME, model };
    // HTTP status is non-secret and invaluable for diagnosing a gateway; attach
    // it to the classified client-error branches below.
    const status =
      error instanceof Anthropic.APIError && typeof error.status === 'number'
        ? error.status
        : undefined;
    const withStatus = status !== undefined ? { ...details, status } : details;

    if (error instanceof Anthropic.APIUserAbortError) {
      return new RetryableError('llm_aborted', 'Claude request was aborted or timed out', {
        cause: error,
        details,
      });
    }
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return new RetryableError('llm_timeout', 'Claude request timed out', { cause: error, details });
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return new RetryableError('llm_connection', 'could not connect to Claude', {
        cause: error,
        details,
      });
    }
    if (error instanceof Anthropic.RateLimitError) {
      return new RetryableError('llm_rate_limited', 'Claude rate limit exceeded', {
        cause: error,
        details: withStatus,
      });
    }
    if (
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError
    ) {
      return new PermanentError('llm_auth', 'Claude rejected the API credentials', {
        cause: error,
        details: withStatus,
      });
    }
    if (error instanceof Anthropic.NotFoundError) {
      return new PermanentError('llm_invalid_model', 'Claude model or resource was not found', {
        cause: error,
        details: withStatus,
      });
    }
    if (
      error instanceof Anthropic.BadRequestError ||
      error instanceof Anthropic.UnprocessableEntityError
    ) {
      return new PermanentError('llm_invalid_request', 'Claude rejected the request as invalid', {
        cause: error,
        details: withStatus,
      });
    }
    if (error instanceof Anthropic.APIError) {
      const status = typeof error.status === 'number' ? error.status : undefined;
      if (status !== undefined && (status === 408 || status >= 500)) {
        return new RetryableError('llm_server_error', `Claude returned a transient error (${status})`, {
          cause: error,
          details: { ...details, status },
        });
      }
      return new PermanentError(
        'llm_api_error',
        `Claude returned a non-retryable error${status !== undefined ? ` (${status})` : ''}`,
        { cause: error, details: status !== undefined ? { ...details, status } : details },
      );
    }

    return new PermanentError('llm_unknown', 'unexpected failure calling Claude', {
      cause: error,
      details,
    });
  }
}

/**
 * Build a `ClaudeProvider` from validated environment config. The single bridge
 * from `Env` to the provider: it fails clearly if the key is absent, which is
 * why the application can boot without one — the failure happens only here, when
 * something actually asks for a Claude provider.
 */
export function createClaudeProvider(
  env: Pick<
    Env,
    'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_BASE_URL' | 'ANTHROPIC_MODEL'
  >,
  logger: Logger,
): ClaudeProvider {
  if (env.ANTHROPIC_API_KEY === undefined && env.ANTHROPIC_AUTH_TOKEN === undefined) {
    throw new PermanentError(
      'llm_missing_api_key',
      'neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set; the Claude provider cannot be created',
      { details: { provider: PROVIDER_NAME } },
    );
  }
  return new ClaudeProvider({
    ...(env.ANTHROPIC_API_KEY !== undefined ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
    ...(env.ANTHROPIC_AUTH_TOKEN !== undefined ? { authToken: env.ANTHROPIC_AUTH_TOKEN } : {}),
    ...(env.ANTHROPIC_BASE_URL !== undefined ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
    model: env.ANTHROPIC_MODEL,
    logger,
  });
}

/** Concatenate the text blocks of a response; non-text blocks are ignored. */
function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * Translate our neutral tool messages to the SDK's `MessageParam[]`. The SDK has
 * no generic "tool" role: a neutral `{role:'tool'}` becomes a `user` message
 * whose content is `tool_result` blocks, and an assistant tool request becomes an
 * `assistant` message whose content is `tool_use` blocks. A plain user turn maps
 * straight across.
 */
function toSdkToolMessages(messages: readonly LlmToolMessage[]): Anthropic.MessageParam[] {
  return messages.map((message): Anthropic.MessageParam => {
    if (message.role === 'user') {
      return { role: 'user', content: message.content };
    }
    if (message.role === 'assistant') {
      const content: Anthropic.ToolUseBlockParam[] = message.toolCalls.map((call) => ({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.arguments,
      }));
      return { role: 'assistant', content };
    }
    // role === 'tool': fold each safe result into a `tool_result` block on a USER
    // message. The block content is the normalized output or the safe error only.
    const content: Anthropic.ToolResultBlockParam[] = message.results.map((result) => {
      const isError = result.error !== undefined;
      return {
        type: 'tool_result',
        tool_use_id: result.id,
        content: JSON.stringify(isError ? result.error : (result.output ?? null)),
        ...(isError ? { is_error: true } : {}),
      };
    });
    return { role: 'user', content };
  });
}

/**
 * Build the SDK tool list from the model-facing definitions. Only name,
 * description, and a JSON-Schema view of the Zod input schema cross the boundary
 * — never a provider, connection, tenant, or credential.
 */
function toSdkTools(tools: readonly LlmToolDefinition[]): Anthropic.ToolUnion[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: z.toJSONSchema(tool.inputSchema) as Anthropic.Tool.InputSchema,
  }));
}

/** Map a response's `tool_use` blocks onto our neutral {@link LlmToolCall[]}. */
function extractToolCalls(content: Anthropic.ContentBlock[]): LlmToolCall[] {
  return content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
    .map((block) => ({ id: block.id, name: block.name, arguments: block.input }));
}

/** Normalize the SDK's usage into our own shape, computing the total. */
function toUsage(usage: Anthropic.Usage): LlmUsage {
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

/** Whole-millisecond wall-clock elapsed since a `performance.now()` mark. */
function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
