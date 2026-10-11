/**
 * `llm:readiness` — strict production LLM-gateway readiness check.
 *
 *   pnpm llm:readiness
 *
 * Proves, against the SAME Anthropic-compatible gateway / token / model the worker uses,
 * that authentication, the configured model, AND strict structured output all work — by
 * sending ONE tiny fixed request and requiring the exact result {"ok": true}. Unlike
 * `llm:smoke`, it FAILS (nonzero) when the credential is absent, the model is rejected,
 * auth fails, or the structured-output contract is not met, so a green run reliably proves
 * readiness.
 *
 * It uses the real Claude provider (the existing LlmProvider abstraction — never handwritten
 * HTTP), makes exactly one network call, opens NO database, and prints only a sanitized
 * PASS/FAIL, the model id, and aggregate token usage — never a credential, Authorization
 * header, base URL, raw response body, gateway error text, or prompt/output content.
 *
 * It proves auth/model/structured-output compatibility, NOT the full GitHub tool-calling loop.
 */
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import type { Env } from '@/config/env.js';
import { isAppError } from '@/domain/errors.js';
import type { LlmProvider } from '@/domain/llm.js';
import { createClaudeProvider } from '@/llm/claude-provider.js';
import { createLogger } from '@/observability/logger.js';
import type { Logger } from '@/observability/logger.js';

/** The provider surface this check needs; the real ClaudeProvider satisfies it. */
export type ReadinessProvider = Pick<LlmProvider, 'name' | 'defaultModel' | 'completeStructured'>;

/** The ANTHROPIC fields createClaudeProvider consumes — the only config this check reads. */
export type AnthropicEnvPick = Pick<
  Env,
  'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_BASE_URL' | 'ANTHROPIC_MODEL'
>;

/** Raw, possibly-absent config as read from the environment (model may be unset). */
export interface RawAnthropicConfig {
  readonly ANTHROPIC_API_KEY?: string | undefined;
  readonly ANTHROPIC_AUTH_TOKEN?: string | undefined;
  readonly ANTHROPIC_BASE_URL?: string | undefined;
  readonly ANTHROPIC_MODEL?: string | undefined;
}

/** Strict expected structured result: exactly `{ ok: true }` and nothing else. */
export const READINESS_SCHEMA = z.object({ ok: z.literal(true) }).strict();

export interface ReadinessVerdict {
  readonly outcome: 'pass' | 'fail';
  readonly errorCode?: string;
  readonly exitCode: 0 | 1;
}

/**
 * Core: send ONE strict structured-output request and require `{ "ok": true }`. The provider
 * validates the response against READINESS_SCHEMA internally, so a wrong or missing field
 * throws (→ a sanitized FAIL). Prints only PASS/FAIL + model + token usage; never a
 * credential, response body, URL, or gateway error text.
 */
export async function runLlmReadiness(options: {
  readonly provider: ReadinessProvider;
  readonly stdout?: NodeJS.WritableStream;
}): Promise<ReadinessVerdict> {
  const out = options.stdout ?? process.stdout;
  try {
    const result = await options.provider.completeStructured({
      messages: [{ role: 'user', content: 'Reply with the JSON object {"ok": true} and nothing else.' }],
      maxOutputTokens: 64,
      schema: READINESS_SCHEMA,
    });
    const u = result.usage;
    out.write(
      `RESULT: PASS — model=${result.model} input_tokens=${u.inputTokens} ` +
        `output_tokens=${u.outputTokens} total_tokens=${u.totalTokens}\n`,
    );
    return { outcome: 'pass', exitCode: 0 };
  } catch (error) {
    // AppError codes are typed, non-secret (e.g. llm_auth, llm_invalid_model,
    // llm_structured_parse_failed). Never surface the raw message, body, or URL.
    const code = isAppError(error) ? error.code : 'llm_unknown';
    out.write(`RESULT: FAIL [${code}] — the LLM readiness check failed.\n`);
    return { outcome: 'fail', errorCode: code, exitCode: 1 };
  }
}

export interface LlmReadinessDeps {
  readonly readConfig: () => RawAnthropicConfig;
  readonly createLogger: () => Logger;
  readonly createProvider: (env: AnthropicEnvPick, logger: Logger) => ReadinessProvider;
}

const DEFAULT_DEPS: LlmReadinessDeps = {
  // Read ONLY the ANTHROPIC vars (same sources the worker uses). No DATABASE_URL, no DB.
  readConfig: () => ({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  }),
  // A silent logger: the provider logs metadata only, and silent keeps output to the single
  // RESULT line. createLogger reads only NODE_ENV + LOG_LEVEL.
  createLogger: () =>
    createLogger({ NODE_ENV: 'production', LOG_LEVEL: 'silent' } as unknown as Env, { service: 'cli' }),
  createProvider: (env, logger) => createClaudeProvider(env, logger),
};

export interface LlmReadinessIo {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

/**
 * Run the check end to end (never throws). Fails nonzero — never silently green — when the
 * credential or model is absent, so a missing config can never pass; then it builds the real
 * provider and runs exactly one structured request.
 */
export async function runCli(io: LlmReadinessIo, deps: LlmReadinessDeps = DEFAULT_DEPS): Promise<0 | 1> {
  const cfg = deps.readConfig();
  if (cfg.ANTHROPIC_API_KEY === undefined && cfg.ANTHROPIC_AUTH_TOKEN === undefined) {
    io.stdout.write('RESULT: FAIL [llm_missing_api_key] — no Anthropic credential is configured.\n');
    return 1;
  }
  const model = cfg.ANTHROPIC_MODEL?.trim();
  if (model === undefined || model === '') {
    io.stdout.write('RESULT: FAIL [llm_model_not_configured] — ANTHROPIC_MODEL is not set.\n');
    return 1;
  }

  try {
    const env: AnthropicEnvPick = {
      ...(cfg.ANTHROPIC_API_KEY !== undefined ? { ANTHROPIC_API_KEY: cfg.ANTHROPIC_API_KEY } : {}),
      ...(cfg.ANTHROPIC_AUTH_TOKEN !== undefined ? { ANTHROPIC_AUTH_TOKEN: cfg.ANTHROPIC_AUTH_TOKEN } : {}),
      ...(cfg.ANTHROPIC_BASE_URL !== undefined ? { ANTHROPIC_BASE_URL: cfg.ANTHROPIC_BASE_URL } : {}),
      ANTHROPIC_MODEL: model,
    };
    const provider = deps.createProvider(env, deps.createLogger());
    const verdict = await runLlmReadiness({ provider, stdout: io.stdout });
    return verdict.exitCode;
  } catch (error) {
    io.stdout.write(
      `RESULT: FAIL [${isAppError(error) ? error.code : 'llm_unknown'}] — the LLM readiness check could not run.\n`,
    );
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runCli({ stdout: process.stdout, stderr: process.stderr });
}

// Run `main` only when executed directly, so tests import the pure helpers above without
// reading env or making any network call.
const invokedPath = process.argv[1];
const isEntrypoint = invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href;
if (isEntrypoint) {
  await main();
}
