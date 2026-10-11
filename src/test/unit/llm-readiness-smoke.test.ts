/**
 * Offline unit tests for the `llm:readiness` CLI. No network: a fake provider stands in for
 * Claude. They prove the strict structured check PASSes only on {ok:true}, FAILs nonzero on
 * auth/model/structured/unknown errors (sanitized, no raw leak), fails without a credential
 * or model WITHOUT building a provider or calling the network (no false-success skip), and
 * builds the provider with the configured model.
 */
import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  READINESS_SCHEMA,
  runCli,
  runLlmReadiness,
  type LlmReadinessDeps,
  type RawAnthropicConfig,
  type ReadinessProvider,
} from '@/cli/llm-readiness-smoke.js';
import { PermanentError } from '@/domain/errors.js';

function collect(): { stream: NodeJS.WritableStream; text: () => string } {
  let buf = '';
  const stream = new Writable({ write(chunk, _enc, cb) { buf += String(chunk); cb(); } });
  return { stream, text: () => buf };
}

type StructReq = { readonly messages: unknown; readonly maxOutputTokens: number; readonly schema: unknown };

const okCompletion = (model = 'fake-model') => ({
  data: { ok: true },
  model,
  usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
  latencyMs: 1,
  provider: 'claude',
});

/** A fake ReadinessProvider whose completeStructured resolves/rejects per `impl`. */
function makeProvider(impl: (req: StructReq) => Promise<unknown>) {
  const completeStructured = vi.fn(impl);
  const provider = { name: 'claude', defaultModel: 'fake-model', completeStructured } as unknown as ReadinessProvider;
  return { provider, completeStructured };
}

describe('runLlmReadiness — strict structured check', () => {
  it('PASSes and prints model + usage when the model returns {ok:true}', async () => {
    const { provider, completeStructured } = makeProvider(async () => okCompletion('m1'));
    const out = collect();
    const v = await runLlmReadiness({ provider, stdout: out.stream });
    expect(v).toEqual({ outcome: 'pass', exitCode: 0 });
    expect(completeStructured).toHaveBeenCalledTimes(1); // the network call is never skipped
    const req = completeStructured.mock.calls[0]![0];
    expect(req.maxOutputTokens).toBe(64);
    expect(req.schema).toBe(READINESS_SCHEMA);
    expect(out.text()).toBe('RESULT: PASS — model=m1 input_tokens=5 output_tokens=2 total_tokens=7\n');
  });

  it('FAILs [llm_auth] on an auth error (exit 1), leaking no detail', async () => {
    const { provider } = makeProvider(async () => {
      throw new PermanentError('llm_auth', 'Claude rejected the API credentials', {
        details: { status: 401, secretish: 'DO_NOT_LEAK' },
      });
    });
    const out = collect();
    const v = await runLlmReadiness({ provider, stdout: out.stream });
    expect(v).toMatchObject({ outcome: 'fail', errorCode: 'llm_auth', exitCode: 1 });
    expect(out.text()).toContain('[llm_auth]');
    expect(out.text()).not.toContain('DO_NOT_LEAK');
    expect(out.text()).not.toContain('401');
  });

  it('FAILs [llm_structured_parse_failed] when the structured output is invalid', async () => {
    const { provider } = makeProvider(async () => {
      throw new PermanentError('llm_structured_parse_failed', 'did not match the requested schema');
    });
    const v = await runLlmReadiness({ provider, stdout: collect().stream });
    expect(v).toMatchObject({ outcome: 'fail', errorCode: 'llm_structured_parse_failed', exitCode: 1 });
  });

  it('sanitizes a non-AppError throw to [llm_unknown] without leaking it', async () => {
    const { provider } = makeProvider(async () => { throw new Error('raw-boom-detail'); });
    const out = collect();
    const v = await runLlmReadiness({ provider, stdout: out.stream });
    expect(v).toMatchObject({ outcome: 'fail', errorCode: 'llm_unknown', exitCode: 1 });
    expect(out.text()).not.toContain('raw-boom-detail');
  });
});

describe('runCli — credential/model gates and provider wiring', () => {
  it('FAILs [llm_missing_api_key] and never builds a provider when no credential is set', async () => {
    const createProvider = vi.fn((_env: unknown, _logger: unknown) => makeProvider(async () => okCompletion()).provider);
    const out = collect();
    const code = await runCli({ stdout: out.stream, stderr: collect().stream }, {
      readConfig: () => ({ ANTHROPIC_MODEL: 'm' }),
      createLogger: () => ({} as never),
      createProvider,
    });
    expect(code).toBe(1);
    expect(out.text()).toContain('[llm_missing_api_key]');
    expect(createProvider).not.toHaveBeenCalled(); // no network, no false success
  });

  it('FAILs [llm_model_not_configured] when ANTHROPIC_MODEL is unset', async () => {
    const createProvider = vi.fn((_env: unknown, _logger: unknown) => makeProvider(async () => okCompletion()).provider);
    const out = collect();
    const code = await runCli({ stdout: out.stream, stderr: collect().stream }, {
      readConfig: () => ({ ANTHROPIC_AUTH_TOKEN: 't' }),
      createLogger: () => ({} as never),
      createProvider,
    });
    expect(code).toBe(1);
    expect(out.text()).toContain('[llm_model_not_configured]');
    expect(createProvider).not.toHaveBeenCalled();
  });

  it('builds the provider with the configured model and PASSes on {ok:true}', async () => {
    const { provider, completeStructured } = makeProvider(async () => okCompletion('prod-model'));
    const createProvider = vi.fn((_env: unknown, _logger: unknown) => provider);
    const out = collect();
    const code = await runCli({ stdout: out.stream, stderr: collect().stream }, {
      readConfig: () => ({ ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_MODEL: 'prod-model' }),
      createLogger: () => ({} as never),
      createProvider,
    });
    expect(code).toBe(0);
    expect(completeStructured).toHaveBeenCalledTimes(1);
    const env = createProvider.mock.calls[0]![0] as { ANTHROPIC_MODEL?: string; ANTHROPIC_AUTH_TOKEN?: string };
    expect(env.ANTHROPIC_MODEL).toBe('prod-model');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('t');
    expect(out.text()).toContain('RESULT: PASS');
  });

  it('FAILs cleanly when provider construction throws (e.g. ambiguous credentials)', async () => {
    const createProvider = vi.fn((_env: unknown, _logger: unknown) => {
      throw new PermanentError('llm_ambiguous_credentials', 'configure exactly one');
    });
    const out = collect();
    const code = await runCli({ stdout: out.stream, stderr: collect().stream }, {
      readConfig: () => ({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'm' }),
      createLogger: () => ({} as never),
      createProvider,
    } as unknown as LlmReadinessDeps);
    expect(code).toBe(1);
    expect(out.text()).toContain('[llm_ambiguous_credentials]');
  });
});

describe('runCli — ANTHROPIC_BASE_URL validation (before any provider build or network)', () => {
  const bearer = (url?: string): RawAnthropicConfig => ({
    ANTHROPIC_AUTH_TOKEN: 't',
    ANTHROPIC_MODEL: 'm',
    ANTHROPIC_BASE_URL: url,
  });
  const neverProvider = () =>
    vi.fn(
      (_env: unknown, _logger: unknown) =>
        ({ name: 'claude', defaultModel: 'm', completeStructured: vi.fn() }) as unknown as ReadinessProvider,
    );
  async function run(cfg: RawAnthropicConfig, createProvider: LlmReadinessDeps['createProvider']) {
    const out = collect();
    const code = await runCli(
      { stdout: out.stream, stderr: collect().stream },
      { readConfig: () => cfg, createLogger: () => ({}) as never, createProvider },
    );
    return { code, text: out.text() };
  }

  it('bearer mode: FAILs [llm_base_url_required] when the URL is missing/empty, no provider built', async () => {
    for (const url of [undefined, '   ']) {
      const createProvider = neverProvider();
      const { code, text } = await run(bearer(url), createProvider);
      expect(code).toBe(1);
      expect(text).toContain('[llm_base_url_required]');
      expect(createProvider).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['unparseable', 'not a url'],
    ['insecure http', 'http://gw.example'],
    ['trailing /v1', 'https://gw.example/v1'],
    ['trailing /v1/', 'https://gw.example/v1/'],
  ])('FAILs [llm_base_url_invalid] for %s — no provider built, URL not printed', async (_label, url) => {
    const createProvider = neverProvider();
    const { code, text } = await run(bearer(url), createProvider);
    expect(code).toBe(1);
    expect(text).toContain('[llm_base_url_invalid]');
    expect(text).not.toContain(url);
    expect(createProvider).not.toHaveBeenCalled();
  });

  it.each([
    ['bare https origin', 'https://gw.example'],
    ['https with a base path', 'https://gw.example/api/anthropic'],
  ])('accepts %s and proceeds to build the provider and PASS', async (_label, url) => {
    const { provider, completeStructured } = makeProvider(async () => okCompletion('m'));
    const createProvider = vi.fn((_env: unknown, _logger: unknown) => provider);
    const { code } = await run(bearer(url), createProvider);
    expect(code).toBe(0);
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(completeStructured).toHaveBeenCalledTimes(1);
  });

  it('direct API-key mode: allows an absent base URL but still rejects an invalid one', async () => {
    const { provider } = makeProvider(async () => okCompletion());
    const okFactory = vi.fn((_env: unknown, _logger: unknown) => provider);
    expect((await run({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'm' }, okFactory)).code).toBe(0);
    expect(okFactory).toHaveBeenCalledTimes(1);

    const never = neverProvider();
    const bad = await run({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'm', ANTHROPIC_BASE_URL: 'http://gw' }, never);
    expect(bad.code).toBe(1);
    expect(bad.text).toContain('[llm_base_url_invalid]');
    expect(never).not.toHaveBeenCalled();
  });
});
