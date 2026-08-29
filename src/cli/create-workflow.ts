/**
 * Bootstrap helper: create a test workflow for a tenant.
 *
 * The minimal testing interface the spec asks for — enough to prove the service
 * end-to-end against a real database without a dashboard or REST surface. It
 * authors a workflow whose version 1 is a linear two-step `noop` definition and a
 * `webhook` trigger, then prints the ids.
 *
 *   pnpm workflow:create <tenantId> "<name>" [webhookSource]
 *
 * `webhookSource` defaults to `test`. Nothing here executes the workflow — Step 4A
 * is data only; there is no engine yet.
 */

import { loadEnv } from '@/config/env.js';
import { createDatabase } from '@/db/client.js';
import { createLogger } from '@/observability/logger.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import { WorkflowRepository } from '@/repositories/workflow-repository.js';

const tenantId = process.argv[2];
const name = process.argv[3];
const source = process.argv[4] ?? 'test';
if (tenantId === undefined || name === undefined || name.trim() === '') {
  process.stderr.write('usage: pnpm workflow:create <tenantId> "<name>" [webhookSource]\n');
  process.exit(1);
}

const env = loadEnv();
const logger = createLogger(env, { service: 'cli' });
const database = createDatabase(env, logger, { service: 'cli' });

try {
  await database.verifyConnection();

  const repository = new WorkflowRepository(new TenantScope(database.db, tenantId));
  const { workflow, version } = await repository.create({
    name: name.trim(),
    definition: {
      version: 1,
      steps: [
        { key: 'first', type: 'noop', config: {} },
        { key: 'second', type: 'noop', config: {} },
      ],
    },
    triggerType: 'webhook',
    triggerConfig: { source },
  });

  process.stdout.write(
    [
      'created workflow',
      `  workflow id: ${workflow.id}`,
      `  name:        ${workflow.name}`,
      `  version:     ${version.version} (id ${version.id})`,
      `  active:      ${version.isActive}`,
      `  trigger:     ${version.triggerType} (source=${source})`,
      '',
    ].join('\n') + '\n',
  );
} catch (error) {
  logger.fatal({ err: error }, 'failed to create workflow');
  process.exitCode = 1;
} finally {
  await database.close();
}
