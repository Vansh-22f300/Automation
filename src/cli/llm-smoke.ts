/**
 * Optional live smoke test for the Claude provider.
 *
 *   pnpm llm:smoke ["your question here"]
 *
 * This is the ONE place that makes a real network call, and only when a
 * credential is configured — an `ANTHROPIC_API_KEY` (direct Anthropic, sent as
 * x-api-key) or an `ANTHROPIC_AUTH_TOKEN` (an Anthropic-compatible gateway, sent
 * as a bearer token, usually alongside `ANTHROPIC_BASE_URL`). It exists so a
 * human can confirm, by eye, that credentials, base URL, model selection,
 * normalization and usage metering all work end to end against the live API. It
 * is never part of the automated suite; `pnpm test` passes and `pnpm build`
 * succeeds with no credential present.
 *
 * It prints only normalized metadata, the resolved endpoint *origin* (host only,
 * never a path or query) and the model's answer — never the API key, the auth
 * token, or any Authorization header. If no credential is set it exits cleanly
 * with a clear message rather than failing, so it is safe to wire into scripts.
 *
 * Two checks run in sequence: (1) a plain text completion, and — only if that
 * succeeds — (2) a tiny structured-output request. The second is reported
 * separately, because a gateway can support plain completions while rejecting
 * the structured-output request fields the SDK sends.
 */

import { loadEnv } from '@/config/env.js';
import { createLogger } from '@/observability/logger.js';
import { createClaudeProvider } from '@/llm/claude-provider.js';
import { isAppError } from '@/domain/errors.js';
import { z } from 'zod';

const env = loadEnv();

if (env.ANTHROPIC_API_KEY === undefined && env.ANTHROPIC_AUTH_TOKEN === undefined) {
  process.stdout.write(
    'No Claude credential set — skipping the live smoke test.\n' +
      'Set one in your .env to run this:\n' +
      '  - ANTHROPIC_API_KEY=sk-ant-...              (direct Anthropic, x-api-key)\n' +
      '  - ANTHROPIC_AUTH_TOKEN=...  with            (Anthropic-compatible gateway, bearer)\n' +
      '    ANTHROPIC_BASE_URL=https://your-gateway    (origin only, no /v1)\n',
  );
  process.exit(0);
}

const question = process.argv[2]?.trim() || 'In one short sentence, what is a workflow?';

// Host/origin only — never the full URL (no path, no query, no credentials).
const endpointOrigin =
  env.ANTHROPIC_BASE_URL !== undefined
    ? new URL(env.ANTHROPIC_BASE_URL).origin
    : 'https://api.anthropic.com (default)';
const authMode = env.ANTHROPIC_AUTH_TOKEN !== undefined ? 'bearer token' : 'x-api-key';

/** A sanitized one-line description of a failure — code, message, HTTP status. */
function describeFailure(error: unknown): string {
  if (isAppError(error)) {
    const status = (error.details as { status?: number } | undefined)?.status;
    return `[${error.code}] ${error.message}${status !== undefined ? ` (HTTP ${status})` : ''}`;
  }
  return 'an unexpected, unclassified error';
}

const logger = createLogger(env, { service: 'cli' });
const provider = createClaudeProvider(env, logger);

process.stdout.write(
  [
    'Claude smoke test',
    `  provider:      ${provider.name}`,
    `  endpoint:      ${endpointOrigin}`,
    `  auth:          ${authMode}`,
    `  model:         ${provider.defaultModel}`,
    '',
  ].join('\n') + '\n',
);

// (1) Plain text completion.
let plainOk = false;
try {
  const result = await provider.complete({
    messages: [{ role: 'user', content: question }],
    maxOutputTokens: 256,
  });
  plainOk = true;

  process.stdout.write(
    [
      'Plain completion — OK',
      `  model:         ${result.model}`,
      `  latency:       ${result.latencyMs}ms`,
      `  input tokens:  ${result.usage.inputTokens}`,
      `  output tokens: ${result.usage.outputTokens}`,
      `  total tokens:  ${result.usage.totalTokens}`,
      `  question:      ${question}`,
      `  answer:        ${result.text.replace(/\s+/g, ' ').trim().slice(0, 300)}`,
      '',
    ].join('\n') + '\n',
  );
} catch (error) {
  process.stderr.write(`Plain completion — FAILED: ${describeFailure(error)}\n`);
  process.exitCode = 1;
}

// (2) Structured output — only attempted if plain completion worked, since a
// gateway that cannot even do plain text tells us nothing new here.
if (plainOk) {
  try {
    const result = await provider.completeStructured({
      messages: [
        { role: 'user', content: 'Reply with the JSON object {"ok": true} and nothing else.' },
      ],
      maxOutputTokens: 64,
      schema: z.object({ ok: z.boolean() }),
    });
    process.stdout.write(
      [
        'Structured output — OK',
        `  data:          ${JSON.stringify(result.data)}`,
        `  total tokens:  ${result.usage.totalTokens}`,
        '',
      ].join('\n') + '\n',
    );
  } catch (error) {
    // Not a hard failure of the smoke test: report it distinctly so the operator
    // knows plain completions work but structured output does not on this endpoint.
    process.stdout.write(`Structured output — NOT SUPPORTED / FAILED: ${describeFailure(error)}\n`);
  }
}
