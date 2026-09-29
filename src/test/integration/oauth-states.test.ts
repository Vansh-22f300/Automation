/**
 * Integration tests for the Postgres-backed OAuth STATE STORE
 * (`DrizzleOAuthStateStore`) — the security spine of the OAuth foundation.
 * They require a real PostgreSQL and are SKIPPED (never faked) unless
 * `TEST_DATABASE_URL` is set.
 *
 * These drive the REAL store against the REAL `oauth_states` table (migration
 * 0016) with the REAL `OAuthStateSecretBox` (AES-256-GCM, AAD = state_hash),
 * proving what the offline unit tests cannot:
 *
 *   - a created state is SINGLE-USE: the first valid consume returns the bound
 *     { tenantId, userId, provider, returnPath, codeVerifier }; a second consume
 *     of the same hash returns null;
 *   - the PKCE verifier survives a real encrypt → store → fetch → decrypt
 *     roundtrip, and is NEVER stored in plaintext;
 *   - expiry, wrong-provider, and unknown-hash lookups fail closed WITHOUT
 *     burning a still-valid state;
 *   - the AAD binds each verifier to its OWN state_hash: a cross-row envelope
 *     swap fails decryption;
 *   - two simultaneous callbacks race for one row and EXACTLY ONE wins;
 *   - each state recovers its OWN tenant/user (identity is read from the row,
 *     never from the caller);
 *   - bounded cleanup removes only dead (expired/consumed) rows, never a live one.
 *
 * The `oauth_states` composite FK (tenant_id, user_id) → memberships requires a
 * membership per (tenant, user); the seed creates two isolated identities.
 * Cleanup deletes the tenants (cascading memberships → oauth_states) and users.
 */

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '@/db/client.js';
import { memberships, oauthStates, tenants, users } from '@/db/schema.js';
import { generateCodeVerifier } from '@/oauth/pkce.js';
import { OAuthStateSecretError, createOAuthStateSecretBox } from '@/oauth/state-secret-box.js';
import { generateOAuthState, hashOAuthState } from '@/oauth/state-token.js';
import { DrizzleOAuthStateStore } from '@/repositories/oauth-state-repository.js';
import { CredentialCipher, generateCredentialKey, parseCredentialKey } from '@/security/credential-cipher.js';
import { KeyRing } from '@/security/keyring.js';

import { TEST_DATABASE_URL, createTestDatabaseHandle } from './support.js';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const email = (who: string): string => `${who}-${RUN}@oauth-states-it.test`;
const TTL_MS = 10 * 60 * 1000;
// A comfortably-past margin for "expired" rows. Expiry is judged by Postgres'
// clock (`expires_at > now()`), so the margin must exceed any app/DB clock skew;
// a tight ~1s past can read as live when the DB clock lags. Matches the hour-wide
// margin the sessions integration suite uses for the same reason.
const HOUR_MS = 60 * 60 * 1000;
describe.skipIf(TEST_DATABASE_URL === undefined)('oauth_states store integration', () => {
  let handle: DatabaseHandle;
  let store: DrizzleOAuthStateStore;
  let a: { tenantId: string; userId: string };
  let b: { tenantId: string; userId: string };
  const tenantIds: string[] = [];
  const userIds: string[] = [];

  // A test-only credential key, generated here — never a real deployment key.
  const cipherKey = parseCredentialKey(generateCredentialKey());
  const cipher = new CredentialCipher(cipherKey, KeyRing.fromLegacyKey(cipherKey));

  const seedIdentity = async (tenantName: string, who: string): Promise<{ tenantId: string; userId: string }> => {
    const [tenant] = await handle.db.insert(tenants).values({ name: tenantName }).returning({ id: tenants.id });
    const tenantId = tenant!.id;
    tenantIds.push(tenantId);
    const [user] = await handle.db
      .insert(users)
      .values({ email: email(who), name: who, status: 'active' })
      .returning({ id: users.id });
    const userId = user!.id;
    userIds.push(userId);
    // The composite FK (tenant_id, user_id) → memberships demands this row first.
    await handle.db.insert(memberships).values({ tenantId, userId, role: 'member', status: 'active' });
    return { tenantId, userId };
  };

  interface Seeded {
    readonly stateHash: string;
    readonly codeVerifier: string;
  }

  const createState = async (opts: {
    identity: { tenantId: string; userId: string };
    provider?: string;
    returnPath?: string;
    expiresAt?: Date;
  }): Promise<Seeded> => {
    const stateHash = hashOAuthState(generateOAuthState());
    const codeVerifier = generateCodeVerifier();
    await store.create({
      tenantId: opts.identity.tenantId,
      userId: opts.identity.userId,
      provider: opts.provider ?? 'github',
      returnPath: opts.returnPath ?? '/connections',
      stateHash,
      codeVerifier,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + TTL_MS),
    });
    return { stateHash, codeVerifier };
  };
  beforeAll(async () => {
    handle = createTestDatabaseHandle();
    await handle.verifyConnection();
    store = new DrizzleOAuthStateStore(handle.db, createOAuthStateSecretBox(cipher));
    a = await seedIdentity(`OAuth States Tenant A ${RUN}`, 'alpha');
    b = await seedIdentity(`OAuth States Tenant B ${RUN}`, 'beta');
  });

  afterAll(async () => {
    if (handle === undefined) return;
    // Deleting tenants cascades memberships → oauth_states; users cascade separately.
    for (const id of tenantIds) await handle.db.delete(tenants).where(eq(tenants.id, id));
    for (const id of userIds) await handle.db.delete(users).where(eq(users.id, id));
    await handle.close();
  });

  it('creates a state and consumes it once, recovering the bound context and PKCE verifier', async () => {
    const { stateHash, codeVerifier } = await createState({
      identity: a,
      provider: 'github',
      returnPath: '/connections?tab=github',
    });

    const consumed = await store.consume({ stateHash, provider: 'github' });
    expect(consumed).toEqual({
      tenantId: a.tenantId,
      userId: a.userId,
      provider: 'github',
      returnPath: '/connections?tab=github',
      // The PKCE verifier survived encrypt → store → fetch → decrypt intact.
      codeVerifier,
    });
  });

  it('never stores the PKCE verifier in plaintext', async () => {
    const { stateHash, codeVerifier } = await createState({ identity: a });
    const [row] = await handle.db
      .select({ enc: oauthStates.encryptedCodeVerifier })
      .from(oauthStates)
      .where(eq(oauthStates.stateHash, stateHash));
    const serialized = JSON.stringify(row!.enc);
    expect(serialized).not.toContain(codeVerifier);
    expect((row!.enc as { alg: string }).alg).toBe('aes-256-gcm');
  });

  it('rejects a second consume of the same state (single-use)', async () => {
    const { stateHash } = await createState({ identity: a });
    expect(await store.consume({ stateHash, provider: 'github' })).not.toBeNull();
    expect(await store.consume({ stateHash, provider: 'github' })).toBeNull();
  });
  it('rejects an expired state and does not consume it', async () => {
    const { stateHash } = await createState({ identity: a, expiresAt: new Date(Date.now() - HOUR_MS) });
    expect(await store.consume({ stateHash, provider: 'github' })).toBeNull();
  });

  it('rejects a consume whose provider does not match the stored state, without burning it', async () => {
    const { stateHash } = await createState({ identity: a, provider: 'github' });
    // Wrong provider → no row matches → null, and crucially the row is NOT consumed...
    expect(await store.consume({ stateHash, provider: 'gmail' })).toBeNull();
    // ...so the correct provider still succeeds afterwards.
    const consumed = await store.consume({ stateHash, provider: 'github' });
    expect(consumed?.provider).toBe('github');
  });

  it('rejects an unknown state hash', async () => {
    const unknownHash = hashOAuthState(generateOAuthState());
    expect(await store.consume({ stateHash: unknownHash, provider: 'github' })).toBeNull();
  });

  it('recovers each state OWN tenant and user, never another identity', async () => {
    const forA = await createState({ identity: a });
    const forB = await createState({ identity: b });
    const consumedA = await store.consume({ stateHash: forA.stateHash, provider: 'github' });
    const consumedB = await store.consume({ stateHash: forB.stateHash, provider: 'github' });
    expect(consumedA).toMatchObject({ tenantId: a.tenantId, userId: a.userId });
    expect(consumedB).toMatchObject({ tenantId: b.tenantId, userId: b.userId });
    expect(consumedA!.tenantId).not.toBe(consumedB!.tenantId);
  });

  it('throws when the stored verifier envelope has been tampered with', async () => {
    const { stateHash } = await createState({ identity: a });
    const [row] = await handle.db
      .select({ enc: oauthStates.encryptedCodeVerifier })
      .from(oauthStates)
      .where(eq(oauthStates.stateHash, stateHash));
    const envelope = row!.enc as { v: number; alg: string; iv: string; ct: string; tag: string };
    // Flip a ciphertext byte: GCM tag verification must now fail on open.
    const ct = Buffer.from(envelope.ct, 'base64');
    ct[0] = ct[0]! ^ 0xff;
    await handle.db
      .update(oauthStates)
      .set({ encryptedCodeVerifier: { ...envelope, ct: ct.toString('base64') } })
      .where(eq(oauthStates.stateHash, stateHash));

    await expect(store.consume({ stateHash, provider: 'github' })).rejects.toBeInstanceOf(OAuthStateSecretError);
  });
  it('binds the verifier to its OWN state hash: a cross-row envelope swap fails to decrypt', async () => {
    const donor = await createState({ identity: a });
    const victim = await createState({ identity: a });
    const [donorRow] = await handle.db
      .select({ enc: oauthStates.encryptedCodeVerifier })
      .from(oauthStates)
      .where(eq(oauthStates.stateHash, donor.stateHash));
    // Overwrite the victim's (valid) envelope with the donor's — sealed under the
    // donor's state_hash AAD, so opening it under the victim's hash must fail.
    await handle.db
      .update(oauthStates)
      .set({ encryptedCodeVerifier: donorRow!.enc })
      .where(eq(oauthStates.stateHash, victim.stateHash));

    await expect(store.consume({ stateHash: victim.stateHash, provider: 'github' })).rejects.toBeInstanceOf(
      OAuthStateSecretError,
    );
  });

  it('allows only ONE of two simultaneous consumes to win the race', async () => {
    const { stateHash } = await createState({ identity: a });
    const [first, second] = await Promise.all([
      store.consume({ stateHash, provider: 'github' }),
      store.consume({ stateHash, provider: 'github' }),
    ]);
    expect([first, second].filter((r) => r !== null)).toHaveLength(1);
  });

  it('preserves the return path verbatim through the roundtrip', async () => {
    const returnPath = '/connections?provider=github&status=connected';
    const { stateHash } = await createState({ identity: a, returnPath });
    const consumed = await store.consume({ stateHash, provider: 'github' });
    expect(consumed?.returnPath).toBe(returnPath);
  });

  it('cleanup removes only dead (expired or consumed) rows, never a live one', async () => {
    const live = await createState({ identity: a });
    const expired = await createState({ identity: a, expiresAt: new Date(Date.now() - HOUR_MS) });
    const consumedSeed = await createState({ identity: a });
    await store.consume({ stateHash: consumedSeed.stateHash, provider: 'github' });

    const removed = await store.deleteExpiredAndConsumed();
    expect(removed).toBeGreaterThanOrEqual(2);

    const survives = async (hash: string): Promise<boolean> =>
      (await handle.db.select({ id: oauthStates.id }).from(oauthStates).where(eq(oauthStates.stateHash, hash)))
        .length > 0;

    expect(await survives(live.stateHash)).toBe(true);
    expect(await survives(expired.stateHash)).toBe(false);
    expect(await survives(consumedSeed.stateHash)).toBe(false);
    // The live row is untouched — still fully consumable.
    expect(await store.consume({ stateHash: live.stateHash, provider: 'github' })).not.toBeNull();
  });
});
