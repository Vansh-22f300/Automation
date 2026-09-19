/**
 * Unit tests for the Claude provider.
 *
 * No test here touches the network: every case injects an `Anthropic` client
 * whose `messages.create` / `messages.parse` are stubbed with `vi.spyOn`, or
 * asserts behaviour that never reaches the SDK at all (construction guards,
 * empty-message rejection). SDK errors are built from the SDK's own classes so
 * the mapping is exercised by *class*, exactly as production classifies them.
 */

import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import pino from 'pino';

import { ClaudeProvider, createClaudeProvider } from '@/llm/claude-provider.js';
import { PermanentError, RetryableError, isRetryable } from '@/domain/errors.js';
import type { Logger } from '@/observability/logger.js';

/** A silent logger for cases that do not assert on log output. */
const silentLogger = pino({ level: 'silent' }) as unknown as Logger;

/** Build a client whose transport is never actually reached. */
function testClient(): Anthropic {
  return new Anthropic({ apiKey: 'test-key', maxRetries: 0 });
}

/** A minimal successful `messages.create` response. */
function fakeMessage(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text: 'hello', citations: null }],
    usage: {
      input_tokens: 12,
      output_tokens: 7,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
    ...overrides,
  } as Anthropic.Message;
}

function makeProvider(client: Anthropic, logger: Logger = silentLogger): ClaudeProvider {
  return new ClaudeProvider({ apiKey: 'test-key', model: 'claude-opus-5', logger, client });
}

describe('ClaudeProvider — construction', () => {
  it('exposes a stable name and the configured default model', () => {
    const provider = makeProvider(testClient());
    expect(provider.name).toBe('claude');
    expect(provider.defaultModel).toBe('claude-opus-5');
  });

  it('throws a PermanentError when the API key is empty', () => {
    expect(
      () => new ClaudeProvider({ apiKey: '', model: 'claude-opus-5', logger: silentLogger }),
    ).toThrow(PermanentError);
  });

  it('throws a PermanentError when the API key is only whitespace', () => {
    try {
      new ClaudeProvider({ apiKey: '   ', model: 'claude-opus-5', logger: silentLogger });
      expect.unreachable('construction should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PermanentError);
      expect((error as PermanentError).code).toBe('llm_missing_api_key');
    }
  });
});

describe('ClaudeProvider — configurable auth & base URL', () => {
  /** Read the private SDK client a provider built for itself. */
  function builtClientOf(config: Omit<ConstructorParameters<typeof ClaudeProvider>[0], 'model' | 'logger'>) {
    const provider = new ClaudeProvider({ model: 'claude-opus-5', logger: silentLogger, ...config });
    return (provider as unknown as { client: Anthropic }).client;
  }

  /** Inspect the request the SDK would send: target URL and auth headers. */
  async function requestShape(client: Anthropic): Promise<{
    url: string;
    apiKey: string | null;
    authorization: string | null;
  }> {
    const { req, url } = await client.buildRequest({ method: 'post', path: '/v1/messages', body: {} });
    const headers = req.headers as Headers;
    const get = (k: string): string | null =>
      typeof headers.get === 'function' ? headers.get(k) : ((headers as never)[k] ?? null);
    return { url, apiKey: get('x-api-key'), authorization: get('authorization') };
  }

  it('uses x-api-key (and no Authorization) when given an API key', async () => {
    const shape = await requestShape(builtClientOf({ apiKey: 'sk-ant-abc' }));
    expect(shape.apiKey).toBe('sk-ant-abc');
    expect(shape.authorization).toBeNull();
  });

  it('uses Authorization: Bearer (and no x-api-key) when given an auth token', async () => {
    const shape = await requestShape(builtClientOf({ authToken: 'gw-token' }));
    expect(shape.authorization).toBe('Bearer gw-token');
    expect(shape.apiKey).toBeNull();
  });

  it('targets the configured base URL, and the SDK appends /v1/messages once', async () => {
    const shape = await requestShape(
      builtClientOf({ authToken: 'gw-token', baseURL: 'https://gateway.example.com' }),
    );
    expect(shape.url).toBe('https://gateway.example.com/v1/messages');
  });

  it('throws llm_ambiguous_credentials when both an API key and an auth token are given', () => {
    try {
      new ClaudeProvider({
        apiKey: 'sk-ant-abc',
        authToken: 'gw-token',
        model: 'claude-opus-5',
        logger: silentLogger,
      });
      expect.unreachable('construction should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PermanentError);
      expect((error as PermanentError).code).toBe('llm_ambiguous_credentials');
      // The secret values must not ride along in the thrown error.
      const serialised = `${(error as PermanentError).message} ${JSON.stringify(
        (error as PermanentError).details,
      )}`;
      expect(serialised).not.toContain('sk-ant-abc');
      expect(serialised).not.toContain('gw-token');
    }
  });

  it('throws llm_missing_api_key when neither credential is given', () => {
    try {
      new ClaudeProvider({ model: 'claude-opus-5', logger: silentLogger });
      expect.unreachable('construction should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PermanentError);
      expect((error as PermanentError).code).toBe('llm_missing_api_key');
    }
  });
});

describe('createClaudeProvider', () => {
  it('builds a provider from env with a key present', () => {
    const provider = createClaudeProvider(
      { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_MODEL: 'claude-opus-5' },
      silentLogger,
    );
    expect(provider.defaultModel).toBe('claude-opus-5');
  });

  it('builds a provider from env in gateway (bearer) mode', () => {
    const provider = createClaudeProvider(
      {
        ANTHROPIC_AUTH_TOKEN: 'gw-token',
        ANTHROPIC_BASE_URL: 'https://gateway.example.com',
        ANTHROPIC_MODEL: 'gateway-model',
      },
      silentLogger,
    );
    expect(provider.defaultModel).toBe('gateway-model');
  });

  it('throws a PermanentError when neither credential is set in env', () => {
    try {
      createClaudeProvider({ ANTHROPIC_MODEL: 'm' }, silentLogger);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PermanentError);
      expect((error as PermanentError).code).toBe('llm_missing_api_key');
    }
  });

  it('throws a PermanentError when ANTHROPIC_API_KEY is explicitly undefined and no token is set', () => {
    try {
      createClaudeProvider({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_MODEL: 'm' }, silentLogger);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PermanentError);
      expect((error as PermanentError).code).toBe('llm_missing_api_key');
    }
  });
});

describe('ClaudeProvider.complete — normalization', () => {
  it('normalizes text, model, usage and provider from the SDK response', async () => {
    const client = testClient();
    const spy = vi.spyOn(client.messages, 'create').mockResolvedValue(fakeMessage());
    const provider = makeProvider(client);

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 100,
    });

    expect(result.text).toBe('hello');
    expect(result.model).toBe('claude-opus-5');
    expect(result.provider).toBe('claude');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7, totalTokens: 19 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('concatenates multiple text blocks and ignores non-text blocks', async () => {
    const client = testClient();
    vi.spyOn(client.messages, 'create').mockResolvedValue(
      fakeMessage({
        content: [
          { type: 'text', text: 'foo', citations: null },
          { type: 'thinking', thinking: 'ignored', signature: '' } as never,
          { type: 'text', text: 'bar', citations: null },
        ],
      }),
    );
    const result = await makeProvider(client).complete({
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 100,
    });
    expect(result.text).toBe('foobar');
  });

  it('uses the request model over the configured default', async () => {
    const client = testClient();
    const spy = vi.spyOn(client.messages, 'create').mockResolvedValue(fakeMessage());
    await makeProvider(client).complete({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 100,
    });
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ model: 'claude-sonnet-5' });
  });

  it('forwards temperature only when provided', async () => {
    const client = testClient();
    const spy = vi.spyOn(client.messages, 'create').mockResolvedValue(fakeMessage());
    const provider = makeProvider(client);

    await provider.complete({ messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 10 });
    expect(spy.mock.calls[0]?.[0]).not.toHaveProperty('temperature');

    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 10,
      temperature: 0.5,
    });
    expect(spy.mock.calls[1]?.[0]).toMatchObject({ temperature: 0.5 });
  });

  it('passes maxRetries:0, the timeout and the abort signal through to the SDK', async () => {
    const client = testClient();
    const spy = vi.spyOn(client.messages, 'create').mockResolvedValue(fakeMessage());
    const controller = new AbortController();

    await makeProvider(client).complete({
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 10,
      timeoutMs: 1234,
      signal: controller.signal,
    });

    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      maxRetries: 0,
      timeout: 1234,
      signal: controller.signal,
    });
  });

  it('rejects an empty message list before calling the SDK', async () => {
    const client = testClient();
    const spy = vi.spyOn(client.messages, 'create');
    await expect(
      makeProvider(client).complete({ messages: [], maxOutputTokens: 10 }),
    ).rejects.toBeInstanceOf(PermanentError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('treats a refusal stop_reason as a PermanentError', async () => {
    const client = testClient();
    vi.spyOn(client.messages, 'create').mockResolvedValue(
      fakeMessage({ stop_reason: 'refusal' }),
    );
    try {
      await makeProvider(client).complete({
        messages: [{ role: 'user', content: 'hi' }],
        maxOutputTokens: 10,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PermanentError);
      expect((error as PermanentError).code).toBe('llm_refused');
    }
  });
});

describe('ClaudeProvider.completeStructured — local JSON parsing via messages.create', () => {
  const schema = z.object({ answer: z.string(), score: z.number() });

  /** A create() response whose single text block is `obj` serialized as JSON. */
  function jsonMessage(obj: unknown): Anthropic.Message {
    return fakeMessage({ content: [{ type: 'text', text: JSON.stringify(obj), citations: null }] });
  }

  it('accepts a create() response whose text is valid JSON and returns validated, typed data', async () => {
    const client = testClient();
    const createSpy = vi.spyOn(client.messages, 'create').mockResolvedValue(jsonMessage({ answer: 'yes', score: 0.9 }));
    const parseSpy = vi.spyOn(client.messages, 'parse');

    const result = await makeProvider(client).completeStructured({
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 100,
      schema,
    });

    expect(result.data).toEqual({ answer: 'yes', score: 0.9 });
    expect(result.provider).toBe('claude');
    expect(result.usage.totalTokens).toBe(19);
    // The structured path no longer relies on the SDK's parse helper.
    expect(createSpy).toHaveBeenCalledOnce();
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('appends a JSON-only directive to the system while preserving the caller system, and still sends output_config', async () => {
    const client = testClient();
    const createSpy = vi.spyOn(client.messages, 'create').mockResolvedValue(jsonMessage({ answer: 'a', score: 1 }));

    await makeProvider(client).completeStructured({
      system: 'ORIGINAL_SYSTEM_TEXT',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 100,
      schema,
    });

    const sent = createSpy.mock.calls[0]?.[0] as unknown as { system?: string; output_config?: unknown };
    expect(sent.system).toContain('ORIGINAL_SYSTEM_TEXT');
    expect(sent.system).toContain('JSON');
    expect(sent).toHaveProperty('output_config');
  });

  it('rejects a schema mismatch (valid JSON, wrong shape) with llm_structured_parse_failed', async () => {
    const client = testClient();
    vi.spyOn(client.messages, 'create').mockResolvedValue(jsonMessage({ answer: 'yes', score: 'not-a-number' }));
    try {
      await makeProvider(client).completeStructured({
        messages: [{ role: 'user', content: 'hi' }],
        maxOutputTokens: 100,
        schema,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PermanentError);
      expect((error as PermanentError).code).toBe('llm_structured_parse_failed');
    }
  });

  it('rejects a prose (non-JSON) response with llm_structured_parse_failed', async () => {
    const client = testClient();
    vi.spyOn(client.messages, 'create').mockResolvedValue(
      fakeMessage({ content: [{ type: 'text', text: 'Posted to the channel successfully.', citations: null }] }),
    );
    await expect(
      makeProvider(client).completeStructured({
        messages: [{ role: 'user', content: 'hi' }],
        maxOutputTokens: 100,
        schema,
      }),
    ).rejects.toMatchObject({ code: 'llm_structured_parse_failed' });
  });
});

describe('ClaudeProvider.converse — tool turns via messages.create', () => {
  const schema = z.object({ message: z.string() });
  const tools = [
    {
      name: 'send_slack_message',
      description: 'Send a message to a Slack channel',
      inputSchema: z.object({ channel: z.string(), text: z.string() }).strict(),
    },
  ];
  const baseRequest = {
    messages: [{ role: 'user' as const, content: 'notify the team' }],
    tools,
    schema,
    maxOutputTokens: 200,
  };

  it('returns tool_use for a thinking + text + tool_use response, without ever parsing the text', async () => {
    const client = testClient();
    const createSpy = vi.spyOn(client.messages, 'create').mockResolvedValue(
      fakeMessage({
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 'the user wants a slack ping', signature: '' },
          { type: 'text', text: 'Sure — sending that now.', citations: null },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'send_slack_message',
            input: { channel: '#ai-workforce-test', text: 'Hello from AI Workforce' },
          },
        ],
      } as never),
    );
    // The parse helper is what used to blow up on the text block; it must not run.
    const parseSpy = vi.spyOn(client.messages, 'parse');

    const result = await makeProvider(client).converse(baseRequest);

    expect(result.kind).toBe('tool_use');
    if (result.kind !== 'tool_use') expect.unreachable('expected a tool_use turn');
    expect(result.toolCalls).toEqual([
      {
        id: 'toolu_1',
        name: 'send_slack_message',
        arguments: { channel: '#ai-workforce-test', text: 'Hello from AI Workforce' },
      },
    ]);
    expect(createSpy).toHaveBeenCalledOnce();
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it('sends the tools, tool_choice:auto and output_config in the request', async () => {
    const client = testClient();
    const createSpy = vi.spyOn(client.messages, 'create').mockResolvedValue(
      fakeMessage({
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 't1', name: 'send_slack_message', input: { channel: '#c', text: 'x' } },
        ],
      } as never),
    );

    await makeProvider(client).converse(baseRequest);

    const sent = createSpy.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(sent).toMatchObject({ tool_choice: { type: 'auto' } });
    expect(sent).toHaveProperty('output_config');
    expect((sent.tools as Array<{ name: string }>)[0]?.name).toBe('send_slack_message');
  });

  it('parses the final structured answer from the response text (create path)', async () => {
    const client = testClient();
    vi.spyOn(client.messages, 'create').mockResolvedValue(
      fakeMessage({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ message: 'all done' }), citations: null }],
      }),
    );

    const result = await makeProvider(client).converse(baseRequest);

    expect(result.kind).toBe('final');
    if (result.kind !== 'final') expect.unreachable('expected a final turn');
    expect(result.data).toEqual({ message: 'all done' });
  });

  it('maps a non-JSON final answer to a permanent llm_structured_parse_failed', async () => {
    const client = testClient();
    vi.spyOn(client.messages, 'create').mockResolvedValue(
      fakeMessage({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'not valid json', citations: null }],
      }),
    );

    try {
      await makeProvider(client).converse(baseRequest);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PermanentError);
      expect((error as PermanentError).code).toBe('llm_structured_parse_failed');
    }
  });

  it('rejects a tool_use stop_reason with no tool_use block as malformed', async () => {
    const client = testClient();
    vi.spyOn(client.messages, 'create').mockResolvedValue(
      fakeMessage({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'hmm', citations: null }] }),
    );

    try {
      await makeProvider(client).converse(baseRequest);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as PermanentError).code).toBe('llm_tool_call_malformed');
    }
  });

  it('runs a tool_use round then a JSON final round to success', async () => {
    const client = testClient();
    vi.spyOn(client.messages, 'create')
      .mockResolvedValueOnce(
        fakeMessage({
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 't1', name: 'send_slack_message', input: { channel: '#c', text: 'x' } },
          ],
        } as never),
      )
      .mockResolvedValueOnce(
        fakeMessage({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify({ message: 'done' }), citations: null }],
        }),
      );
    const provider = makeProvider(client);

    const turn1 = await provider.converse(baseRequest);
    expect(turn1.kind).toBe('tool_use');
    if (turn1.kind !== 'tool_use') expect.unreachable('expected a tool_use turn');

    // The caller feeds the tool result back and asks again — the final answer is
    // parsed locally from the response text.
    const turn2 = await provider.converse({
      ...baseRequest,
      messages: [
        { role: 'user', content: 'notify the team' },
        { role: 'assistant', toolCalls: turn1.toolCalls },
        { role: 'tool', results: [{ id: 't1', output: { ok: true } }] },
      ],
    });
    expect(turn2.kind).toBe('final');
    if (turn2.kind !== 'final') expect.unreachable('expected a final turn');
    expect(turn2.data).toEqual({ message: 'done' });
  });
});

describe('ClaudeProvider — error mapping', () => {
  async function completeRejecting(error: unknown): Promise<unknown> {
    const client = testClient();
    vi.spyOn(client.messages, 'create').mockRejectedValue(error);
    return makeProvider(client)
      .complete({ messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 10 })
      .then(
        () => {
          throw new Error('expected the call to reject');
        },
        (err: unknown) => err,
      );
  }

  it('maps an abort to a retryable llm_aborted', async () => {
    const mapped = await completeRejecting(new Anthropic.APIUserAbortError());
    expect(mapped).toBeInstanceOf(RetryableError);
    expect((mapped as RetryableError).code).toBe('llm_aborted');
  });

  it('maps a connection timeout to a retryable llm_timeout', async () => {
    const mapped = await completeRejecting(
      new Anthropic.APIConnectionTimeoutError({ message: 'timed out' }),
    );
    expect(mapped).toBeInstanceOf(RetryableError);
    expect((mapped as RetryableError).code).toBe('llm_timeout');
  });

  it('maps a connection error to a retryable llm_connection', async () => {
    const mapped = await completeRejecting(
      new Anthropic.APIConnectionError({ message: 'no route' }),
    );
    expect(mapped).toBeInstanceOf(RetryableError);
    expect((mapped as RetryableError).code).toBe('llm_connection');
  });

  it('maps a 429 to a retryable llm_rate_limited', async () => {
    const mapped = await completeRejecting(
      Anthropic.APIError.generate(429, { error: { message: 'slow down' } }, 'rate limited', new Headers()),
    );
    expect(mapped).toBeInstanceOf(RetryableError);
    expect((mapped as RetryableError).code).toBe('llm_rate_limited');
  });

  it('maps a 500 to a retryable llm_server_error', async () => {
    const mapped = await completeRejecting(
      Anthropic.APIError.generate(500, { error: { message: 'boom' } }, 'server error', new Headers()),
    );
    expect(mapped).toBeInstanceOf(RetryableError);
    expect((mapped as RetryableError).code).toBe('llm_server_error');
  });

  it('maps a 401 to a permanent llm_auth', async () => {
    const mapped = await completeRejecting(
      Anthropic.APIError.generate(401, { error: { message: 'bad key' } }, 'unauthorized', new Headers()),
    );
    expect(mapped).toBeInstanceOf(PermanentError);
    expect((mapped as PermanentError).code).toBe('llm_auth');
  });

  it('maps a 403 to a permanent llm_auth', async () => {
    const mapped = await completeRejecting(
      Anthropic.APIError.generate(403, { error: { message: 'forbidden' } }, 'forbidden', new Headers()),
    );
    expect((mapped as PermanentError).code).toBe('llm_auth');
  });

  it('maps a 404 to a permanent llm_invalid_model', async () => {
    const mapped = await completeRejecting(
      Anthropic.APIError.generate(404, { error: { message: 'no model' } }, 'not found', new Headers()),
    );
    expect(mapped).toBeInstanceOf(PermanentError);
    expect((mapped as PermanentError).code).toBe('llm_invalid_model');
  });

  it('maps a 400 to a permanent llm_invalid_request', async () => {
    const mapped = await completeRejecting(
      Anthropic.APIError.generate(400, { error: { message: 'bad request' } }, 'bad request', new Headers()),
    );
    expect(mapped).toBeInstanceOf(PermanentError);
    expect((mapped as PermanentError).code).toBe('llm_invalid_request');
  });

  it('maps a 422 to a permanent llm_invalid_request', async () => {
    const mapped = await completeRejecting(
      Anthropic.APIError.generate(422, { error: { message: 'unprocessable' } }, 'unprocessable', new Headers()),
    );
    expect((mapped as PermanentError).code).toBe('llm_invalid_request');
  });

  it('maps an unknown non-SDK error to a permanent llm_unknown — never retryable', async () => {
    const mapped = await completeRejecting(new Error('something odd'));
    expect(mapped).toBeInstanceOf(PermanentError);
    expect((mapped as PermanentError).code).toBe('llm_unknown');
    expect(isRetryable(mapped)).toBe(false);
  });

  it('maps a base AnthropicError to a permanent llm_response_parse_error, surfacing its message', async () => {
    const mapped = await completeRejecting(
      new Anthropic.AnthropicError('Failed to parse structured output as JSON: Unexpected token'),
    );
    expect(mapped).toBeInstanceOf(PermanentError);
    expect((mapped as PermanentError).code).toBe('llm_response_parse_error');
    expect((mapped as PermanentError).message).toContain('Failed to parse structured output');
    expect(isRetryable(mapped)).toBe(false);
  });
});

describe('ClaudeProvider — observability & security', () => {
  /** A pino logger writing NDJSON into a captured string buffer. */
  function capturingLogger(): { logger: Logger; lines: () => string } {
    let buffer = '';
    const stream = { write: (chunk: string) => { buffer += chunk; return true; } };
    const logger = pino({ level: 'trace' }, stream as unknown as pino.DestinationStream);
    return { logger: logger as unknown as Logger, lines: () => buffer };
  }

  it('logs metadata on success but never the prompt, response text or key', async () => {
    const { logger, lines } = capturingLogger();
    const client = testClient();
    vi.spyOn(client.messages, 'create').mockResolvedValue(
      fakeMessage({ content: [{ type: 'text', text: 'SECRET_RESPONSE', citations: null }] }),
    );

    await makeProvider(client, logger).complete({
      system: 'you are a helper',
      messages: [{ role: 'user', content: 'SECRET_PROMPT' }],
      maxOutputTokens: 50,
    });

    const out = lines();
    expect(out).toContain('"provider":"claude"');
    expect(out).toContain('"input_tokens":12');
    expect(out).toContain('"latency_ms"');
    expect(out).not.toContain('SECRET_PROMPT');
    expect(out).not.toContain('SECRET_RESPONSE');
    expect(out).not.toContain('test-key');
  });

  it('logs err_code on failure without leaking raw SDK error credentials', async () => {
    const { logger, lines } = capturingLogger();
    const client = testClient();
    vi.spyOn(client.messages, 'create').mockRejectedValue(
      Anthropic.APIError.generate(
        401,
        { error: { message: 'invalid x-api-key sk-ant-SECRETKEY' } },
        'unauthorized',
        new Headers(),
      ),
    );

    await makeProvider(client, logger)
      .complete({ messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 10 })
      .catch(() => undefined);

    const out = lines();
    expect(out).toContain('"err_code":"llm_auth"');
    expect(out).not.toContain('sk-ant-SECRETKEY');
  });
});
