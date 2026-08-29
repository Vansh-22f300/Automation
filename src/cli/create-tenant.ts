/**
 * Bootstrap helper: create a tenant.
 *
 * A service/operator script, not an HTTP endpoint — tenant provisioning is an
 * internal act and there is no self-service signup in this stage. Run it to get a
 * tenant id you can then mint the first API key against.
 *
 *   pnpm tenant:create "Acme Corp"
 *
 * It prints the new tenant id to stdout and nothing sensitive.
 */

import { loadEnv } from '@/config/env.js';
import { createDatabase } from '@/db/client.js';
import { createLogger } from '@/observability/logger.js';
import { tenants } from '@/db/schema.js';

const name = process.argv[2];
if (name === undefined || name.trim() === '') {
  process.stderr.write('usage: pnpm tenant:create "<tenant name>"\n');
  process.exit(1);
}

const env = loadEnv();
const logger = createLogger(env, { service: 'cli' });
const database = createDatabase(env, logger, { service: 'cli' });

try {
  await database.verifyConnection();
  const [tenant] = await database.db
    .insert(tenants)
    .values({ name: name.trim() })
    .returning({ id: tenants.id, name: tenants.name });

  // stdout, not the logger: this is the command's result, meant for the operator.
  process.stdout.write(`created tenant\n  id:   ${tenant!.id}\n  name: ${tenant!.name}\n`);
} catch (error) {
  logger.fatal({ err: error }, 'failed to create tenant');
  process.exitCode = 1;
} finally {
  await database.close();
}
