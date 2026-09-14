/**
 * Slack connector integration tests — real PostgreSQL, real ConnectionRepository,
 * real CredentialCipher, real ToolExecutor. The ONLY fake is the Slack transport:
 * these tests never call the live Slack API (that is the separate smoke command).
 *
 * SKIPPED unless `TEST_DATABASE_URL` is set; never faked. A test-only credential key
 * is generated here — never a real Slack token, never a real deployment key.
 *
 *   TEST_DATABASE_URL=postgresql://…/ai_workforce_test pnpm test
 *
 * What these cover that the unit tests cannot:
 *   - a Slack connection's encrypted_credentials on disk contains NO plaintext token
 *   - the trusted connectionId selects EXACTLY the intended connection's token, which
 *     is decrypted at the boundary and handed to the connector — through the real
 *     query builder and cipher
 *   - two active Slack connections coexist for one tenant (Step 9A cardinality fix)
 *   - disabled / cross-tenant / provider-mismatch connections cannot execute
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSendSlackMessageTool } from '@/connectors/slack/send-slack-message.js';
import { SlackConnector } from '@/connectors/slack/slack-connector.js';
import type { DatabaseHandle } from '@/db/client.js';
import { connections, tenants } from '@/db/schema.js';
import type { ConnectionRef } from '@/domain/connection.js';
import type { ToolContext } from '@/domain/tool.js';
import { ToolExecutor } from '@/domain/tool-executor.js';
import { ToolRegistry } from '@/domain/tool-registry.js';
import { ConnectionRepository } from '@/repositories/connection-repository.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import { CredentialCipher, generateCredentialKey, parseCredentialKey } from '@/security/credential-cipher.js';
import { KeyRing } from '@/security/keyring.js';
import { FakeSlackTransport } from '@/test/support/fake-slack-transport.js';

import { TEST_DATABASE_URL, createTestDatabaseHandle } from './support.js';

describe.skipIf(TEST_DATABASE_URL === undefined)('slack connector integration', () => {
  let handle: DatabaseHandle;
  let tenantA: string;
  let tenantB: string;
  const cipherKey = parseCredentialKey(generateCredentialKey());
  const cipher = new CredentialCipher(cipherKey, KeyRing.fromLegacyKey(cipherKey));

  const repoFor = (tenantId: string): ConnectionRepository =>
    new ConnectionRepository(new TenantScope(handle.db, tenantId), cipher);

  const context = (tenantId: string): ToolContext => ({ tenantId, toolName: 'send_slack_message' });

  // Build a fresh executor + fake transport for a given tenant's repository.
  function harnessFor(tenantId: string) {
    const transport = new FakeSlackTransport();
    const connector = new SlackConnector({ transport });
    const registry = new ToolRegistry().register(createSendSlackMessageTool(connector));
    const executor = new ToolExecutor(registry, repoFor(tenantId));
    return { transport, executor };
  }

  const send = (tenantId: string, ref: ConnectionRef, transportExecutor: ReturnType<typeof harnessFor>) =>
    transportExecutor.executor.execute(
      { id: 'c1', name: 'send_slack_message', arguments: { channel: '#ai-workforce-test', text: 'hi' } },
      { context: context(tenantId), connectionRef: ref },
    );

  beforeAll(async () => {
    handle = createTestDatabaseHandle();
    await handle.verifyConnection();
    const inserted = await handle.db
      .insert(tenants)
      .values([{ name: 'Slack Tenant A' }, { name: 'Slack Tenant B' }])
      .returning({ id: tenants.id });
    tenantA = inserted[0]!.id;
    tenantB = inserted[1]!.id;
  });

  afterAll(async () => {
    if (handle === undefined) return;
    for (const id of [tenantA, tenantB]) {
      if (id !== undefined) await handle.db.delete(tenants).where(eq(tenants.id, id));
    }
    await handle.close();
  });

  it('persists Slack connection metadata with no plaintext token on disk', async () => {
    const created = await repoFor(tenantA).create({
      provider: 'slack',
      name: 'my-development-slack',
      credential: { botToken: 'xoxb-ONDISK-SECRET' },
    });
    const [row] = await handle.db.select().from(connections).where(eq(connections.id, created.id));
    expect(row!.provider).toBe('slack');
    expect(JSON.stringify(row)).not.toContain('xoxb-ONDISK-SECRET');
  });

  it('selects the trusted connection and decrypts exactly its token for the connector', async () => {
    const a = await repoFor(tenantA).create({ provider: 'slack', name: 'ws-a', credential: { botToken: 'xoxb-A' } });
    const b = await repoFor(tenantA).create({ provider: 'slack', name: 'ws-b', credential: { botToken: 'xoxb-B' } });

    // Trusted connectionId A → the connector receives A's token.
    const hA = harnessFor(tenantA);
    const rA = await send(tenantA, { provider: 'slack', connectionId: a.id }, hA);
    expect(rA.success).toBe(true);
    expect(hA.transport.lastToken).toBe('xoxb-A');

    // Trusted connectionId B → the connector receives B's token. Two active Slack
    // connections coexisting for the same tenant is allowed.
    const hB = harnessFor(tenantA);
    const rB = await send(tenantA, { provider: 'slack', connectionId: b.id }, hB);
    expect(rB.success).toBe(true);
    expect(hB.transport.lastToken).toBe('xoxb-B');

    // The token appears in neither ToolResult.
    expect(JSON.stringify([rA, rB])).not.toContain('xoxb-A');
    expect(JSON.stringify([rA, rB])).not.toContain('xoxb-B');
  });

  it('refuses a disabled connection before any Slack call', async () => {
    const created = await repoFor(tenantA).create({
      provider: 'slack',
      name: 'ws-disabled',
      credential: { botToken: 'xoxb-DISABLED' },
    });
    await repoFor(tenantA).disable(created.id);

    const h = harnessFor(tenantA);
    const result = await send(tenantA, { provider: 'slack', connectionId: created.id }, h);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('disabled_connection');
    expect(h.transport.calls).toBe(0);
  });

  it('cannot resolve another tenant’s connection (missing, not leaked) — no Slack call', async () => {
    const bConn = await repoFor(tenantB).create({
      provider: 'slack',
      name: 'b-only',
      credential: { botToken: 'xoxb-B-ONLY' },
    });

    const h = harnessFor(tenantA);
    const result = await send(tenantA, { provider: 'slack', connectionId: bConn.id }, h);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('missing_connection');
    expect(h.transport.calls).toBe(0);
  });

  it('refuses a provider mismatch before resolving/executing', async () => {
    const gh = await repoFor(tenantA).create({
      provider: 'github',
      name: 'gh',
      credential: { token: 'ghp-NOT-SLACK' },
    });
    const h = harnessFor(tenantA);
    // The tool is `slack`; a github connectionRef is a wiring error, refused pre-resolve.
    const result = await send(tenantA, { provider: 'github', connectionId: gh.id }, h);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('unauthorized_connection');
    expect(h.transport.calls).toBe(0);
  });
});
