/**
 * Live Slack smoke test — the ONLY code path that calls the real Slack API, and it is
 * NOT part of `pnpm test`. It posts exactly one harmless message to a channel the bot
 * is already in, to prove the end-to-end connector path against a real workspace.
 *
 *   pnpm slack:smoke <tenantId> <connectionId> [channel]
 *
 * `channel` may also come from SLACK_TEST_CHANNEL (defaults to #ai-workforce-test).
 * Requires CREDENTIAL_ENCRYPTION_KEY and a stored, active `slack` connection whose
 * decrypted credential holds a valid botToken. If any of that is absent, it reports
 * "live smoke: NOT executed" and exits 0 — it must never fail an automated pipeline.
 *
 * It prints ONLY safe metadata: tool, provider, connection id, channel, success, a
 * safe error code, latency, and the Slack ts on success. Never the token, the
 * Authorization header, or the credential object.
 */

import { createSlackToolRegistry } from '@/connectors/slack/index.js';
import { SEND_SLACK_MESSAGE_TOOL, SLACK_PROVIDER } from '@/connectors/slack/index.js';
import { loadEnv } from '@/config/env.js';
import { createDatabase } from '@/db/client.js';
import type { ToolContext } from '@/domain/tool.js';
import { ToolExecutor } from '@/domain/tool-executor.js';
import { createLogger } from '@/observability/logger.js';
import { ConnectionRepository } from '@/repositories/connection-repository.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import { createCredentialCipher } from '@/security/credential-cipher.js';

const MESSAGE = 'AI Workforce Slack connector test';

function reportNotExecuted(reason: string): void {
  process.stdout.write(`live smoke: NOT executed (${reason})\n`);
}

const tenantId = process.argv[2];
const connectionId = process.argv[3];
const channel = process.argv[4] ?? process.env.SLACK_TEST_CHANNEL ?? '#ai-workforce-test';

if (tenantId === undefined || connectionId === undefined) {
  process.stderr.write('usage: pnpm slack:smoke <tenantId> <connectionId> [channel]\n');
  process.exit(1);
}

const env = loadEnv();
const logger = createLogger(env, { service: 'slack-smoke' });
const cipher = createCredentialCipher(env);

if (!cipher.hasKey) {
  // No key ⇒ cannot decrypt ⇒ cannot run the live path. Not a failure.
  reportNotExecuted('CREDENTIAL_ENCRYPTION_KEY is not configured');
  process.exit(0);
}

const database = createDatabase(env, logger, { service: 'slack-smoke' });

try {
  await database.verifyConnection();
  const repository = new ConnectionRepository(new TenantScope(database.db, tenantId), cipher);

  // Confirm the trusted connection exists, is active, and is a slack connection —
  // before attempting anything live. Diagnose rather than posting blindly.
  const meta = await repository.getMetadata(connectionId);
  if (meta === null) {
    reportNotExecuted(`no connection ${connectionId} for this tenant`);
    process.exit(0);
  }
  if (meta.provider !== SLACK_PROVIDER) {
    reportNotExecuted(`connection ${connectionId} is provider "${meta.provider}", not slack`);
    process.exit(0);
  }
  if (meta.status !== 'active') {
    reportNotExecuted(`connection ${connectionId} is ${meta.status}`);
    process.exit(0);
  }

  const registry = createSlackToolRegistry({ logger });
  const executor = new ToolExecutor(registry, repository);
  const context: ToolContext = { tenantId, toolName: SEND_SLACK_MESSAGE_TOOL };

  const startedAt = Date.now();
  const result = await executor.execute(
    { id: 'smoke-1', name: SEND_SLACK_MESSAGE_TOOL, arguments: { channel, text: MESSAGE } },
    { context, connectionRef: { provider: SLACK_PROVIDER, connectionId } },
  );
  const latencyMs = Date.now() - startedAt;

  // Print ONLY safe metadata. Never the credential.
  const output = result.output as { channel?: string; ts?: string } | undefined;
  process.stdout.write(
    [
      'live smoke: EXECUTED',
      `  tool:         ${SEND_SLACK_MESSAGE_TOOL}`,
      `  provider:     ${SLACK_PROVIDER}`,
      `  connectionId: ${connectionId}`,
      `  channel:      ${channel}`,
      `  success:      ${result.success}`,
      `  latencyMs:    ${latencyMs}`,
      result.success ? `  ts:           ${output?.ts ?? ''}` : `  errorCode:    ${result.error?.code ?? 'unknown'}`,
      '',
    ].join('\n'),
  );

  if (!result.success && result.error?.code === 'not_in_channel') {
    process.stderr.write(
      'hint: the bot is not a member of the channel. Invite it (/invite @your-bot) rather than adding chat:write.public.\n',
    );
  }
  process.exitCode = result.success ? 0 : 1;
} catch (error) {
  logger.fatal({ err: error }, 'slack smoke failed');
  process.exitCode = 1;
} finally {
  await database.close();
}
