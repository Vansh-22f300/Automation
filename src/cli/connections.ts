/**
 * Bootstrap helper: manage a tenant's external-service connections from the CLI.
 *
 * A dev-only surface — enough to prove the credential boundary end-to-end against a
 * real database without a dashboard or REST API. It never prints a decrypted
 * credential and never prints the encryption key.
 *
 *   pnpm connections create <tenantId> <provider> "<name>" '<credentialJson>'
 *   pnpm connections list   <tenantId>
 *   pnpm connections disable <tenantId> <connectionId>
 *
 * `create` requires `CREDENTIAL_ENCRYPTION_KEY` to be configured; the credential is
 * encrypted before it touches the database. `list` shows metadata only.
 *
 * SECRET INPUT: to keep a token out of shell history and the process argument list,
 * omit the trailing `<credentialJson>` and instead put the JSON in the
 * `CONNECTION_CREDENTIAL_JSON` environment variable. e.g. to store a Slack bot token:
 *
 *   CONNECTION_CREDENTIAL_JSON='{"botToken":"xoxb-…"}' \
 *     pnpm connections create <tenantId> slack "my-development-slack"
 *
 * The credential is never echoed back; only metadata is printed.
 */

import { loadEnv } from '@/config/env.js';
import { createDatabase } from '@/db/client.js';
import { createLogger } from '@/observability/logger.js';
import { ConnectionRepository } from '@/repositories/connection-repository.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import { createCredentialCipher } from '@/security/credential-cipher.js';

function usage(): never {
  process.stderr.write(
    [
      'usage:',
      '  pnpm connections create <tenantId> <provider> "<name>" \'<credentialJson>\'',
      '  pnpm connections list <tenantId>',
      '  pnpm connections disable <tenantId> <connectionId>',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const command = process.argv[2];
const tenantId = process.argv[3];
if (command === undefined || tenantId === undefined) usage();

const env = loadEnv();
const logger = createLogger(env, { service: 'cli' });
const database = createDatabase(env, logger, { service: 'cli' });
const cipher = createCredentialCipher(env);

try {
  await database.verifyConnection();
  const repository = new ConnectionRepository(new TenantScope(database.db, tenantId), cipher);

  if (command === 'create') {
    const provider = process.argv[4];
    const name = process.argv[5];
    // Prefer the env var (keeps secrets out of argv/shell history); fall back to the
    // positional arg for convenience in throwaway dev use.
    const credentialJson = process.env.CONNECTION_CREDENTIAL_JSON ?? process.argv[6];
    if (provider === undefined || name === undefined || credentialJson === undefined) usage();

    let credential: Record<string, unknown>;
    try {
      credential = JSON.parse(credentialJson) as Record<string, unknown>;
    } catch {
      process.stderr.write('credentialJson must be valid JSON, e.g. \'{"token":"xoxb-…"}\'\n');
      process.exit(1);
    }

    const created = await repository.create({ provider, name, credential });
    process.stdout.write(
      [
        'created connection',
        `  id:       ${created.id}`,
        `  provider: ${created.provider}`,
        `  name:     ${created.name}`,
        `  status:   ${created.status}`,
        '',
      ].join('\n') + '\n',
    );
  } else if (command === 'list') {
    const rows = await repository.listMetadata();
    if (rows.length === 0) {
      process.stdout.write('no connections for this tenant\n');
    } else {
      for (const c of rows) {
        process.stdout.write(
          `  ${c.id}  ${c.provider}/${c.name}  [${c.status}]  used=${c.lastUsedAt?.toISOString() ?? 'never'}\n`,
        );
      }
    }
  } else if (command === 'disable') {
    const connectionId = process.argv[4];
    if (connectionId === undefined) usage();
    const updated = await repository.disable(connectionId);
    process.stdout.write(
      updated ? `disabled connection ${updated.id}\n` : `no connection ${connectionId} for this tenant\n`,
    );
  } else {
    usage();
  }
} catch (error) {
  logger.fatal({ err: error }, 'connections command failed');
  process.exitCode = 1;
} finally {
  await database.close();
}
