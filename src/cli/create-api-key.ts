/**
 * Bootstrap helper: mint an API key for a tenant.
 *
 * This is how the *first* key for a tenant is created — you cannot authenticate
 * to the self-service endpoint without already holding one. After that, a tenant
 * can create further keys via `POST /v1/api-keys`.
 *
 *   pnpm apikey:create <tenantId> "CI pipeline"
 *
 * The full key is printed to stdout EXACTLY ONCE. It is never stored in plaintext
 * and never written to the structured log. If you lose it, revoke it and mint a
 * new one.
 */

import { loadEnv } from '@/config/env.js';
import { createDatabase } from '@/db/client.js';
import { createLogger } from '@/observability/logger.js';
import { ApiKeyRepository } from '@/repositories/api-key-repository.js';
import { TenantScope } from '@/repositories/tenant-scope.js';

const tenantId = process.argv[2];
const name = process.argv[3];
if (tenantId === undefined || name === undefined || name.trim() === '') {
  process.stderr.write('usage: pnpm apikey:create <tenantId> "<key name>"\n');
  process.exit(1);
}

const env = loadEnv();
const logger = createLogger(env, { service: 'cli' });
const database = createDatabase(env, logger, { service: 'cli' });

try {
  await database.verifyConnection();

  const repository = new ApiKeyRepository(new TenantScope(database.db, tenantId));
  const created = await repository.create(name.trim());

  // stdout, deliberately outside the logger. This is the one and only time the
  // plaintext key exists after creation.
  process.stdout.write(
    [
      'created api key',
      `  id:     ${created.id}`,
      `  name:   ${created.name}`,
      `  prefix: ${created.prefix}`,
      '',
      '  key (shown once, store it now):',
      `    ${created.plaintext}`,
      '',
    ].join('\n') + '\n',
  );
} catch (error) {
  // Log without the created key. If the insert failed there is no key anyway; if
  // something after it failed, we still never surface the plaintext via the log.
  logger.fatal({ err: error }, 'failed to create api key');
  process.exitCode = 1;
} finally {
  await database.close();
}
