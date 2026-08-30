/**
 * Optional live smoke test for the Claude provider.
 *
 *   pnpm llm:smoke ["your question here"]
 *
 * This is the ONE place that makes a real network call to Anthropic, and only
 * when `ANTHROPIC_API_KEY` is set — it exists so a human can confirm, by eye,
 * that credentials, model selection, normalization and usage metering all work
 * end to end against the live API. It is never part of the automated suite;
 * `pnpm test` passes and `pnpm build` succeeds with no key present.
 *
 * It prints only normalized metadata and the model's answer — never the API
 * key, and never the raw SDK objects. If the key is absent it exits cleanly
 * with a clear message rather than failing, so it is safe to wire into scripts.
 */

import { loadEnv } from '@/config/env.js';
import { createLogger } from '@/observability/logger.js';
import { createClaudeProvider } from '@/llm/claude-provider.js';
import { isAppError } from '@/domain/errors.js';

const env = loadEnv();

if (env.ANTHROPIC_API_KEY === undefined) {
  process.stdout.write(
    'ANTHROPIC_API_KEY is not set — skipping the live Claude smoke test.\n' +
      'Set it in your .env to run this, e.g. ANTHROPIC_API_KEY=sk-ant-...\n',
  );
  process.exit(0);
}

const question = process.argv[2]?.trim() || 'In one short sentence, what is a workflow?';

const logger = createLogger(env, { service: 'cli' });
const provider = createClaudeProvider(env, logger);

try {
  const result = await provider.complete({
    messages: [{ role: 'user', content: question }],
    maxOutputTokens: 256,
  });

  const lines = [
    'Claude smoke test — OK',
    `  provider:      ${result.provider}`,
    `  model:         ${result.model}`,
    `  latency:       ${result.latencyMs}ms`,
    `  input tokens:  ${result.usage.inputTokens}`,
    `  output tokens: ${result.usage.outputTokens}`,
    `  total tokens:  ${result.usage.totalTokens}`,
    '',
    `  question: ${question}`,
    `  answer:   ${result.text}`,
    '',
  ];
  process.stdout.write(lines.join('\n'));
} catch (error) {
  // Never surface the raw SDK error (it may carry credentials/payloads); the
  // provider has already normalized it into a redacted AppError.
  if (isAppError(error)) {
    process.stderr.write(`Claude smoke test failed: [${error.code}] ${error.message}\n`);
  } else {
    process.stderr.write('Claude smoke test failed with an unexpected error.\n');
  }
  process.exitCode = 1;
}
