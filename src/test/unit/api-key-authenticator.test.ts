/**
 * Unit tests for `ApiKeyAuthenticator`.
 *
 * The authenticator is the security decision point: it turns a presented
 * credential into a tenant, or refuses. It is tested against an in-memory
 * `ApiKeyStore` fake so every branch — malformed, unknown prefix, wrong secret,
 * revoked, valid — is exercised with no database.
 *
 * The invariant under test throughout: every failure mode collapses to the same
 * `UnauthorizedError`, so a caller can never tell *why* a key was rejected.
 */

import { describe, expect, it, vi } from 'vitest';

import { UnauthorizedError } from '@/api/errors.js';
import { ApiKeyAuthenticator } from '@/auth/api-key-authenticator.js';
import { generateApiKey } from '@/auth/api-key.js';
import type { ApiKeyStore, AuthApiKeyRecord } from '@/auth/api-key-store.js';

/** In-memory store keyed by prefix, plus a spy on `touchLastUsed`. */
class FakeStore implements ApiKeyStore {
  private readonly byPrefix = new Map<string, AuthApiKeyRecord>();
  readonly touched: string[] = [];

  add(record: AuthApiKeyRecord & { prefix: string }): void {
    this.byPrefix.set(record.prefix, record);
  }

  async findByPrefix(prefix: string): Promise<AuthApiKeyRecord | null> {
    return this.byPrefix.get(prefix) ?? null;
  }

  async touchLastUsed(id: string): Promise<void> {
    this.touched.push(id);
  }
}

/** Seed a store with a real, verifiable key and return its plaintext. */
function seedValidKey(store: FakeStore, over: Partial<AuthApiKeyRecord> = {}): string {
  const key = generateApiKey();
  store.add({
    id: over.id ?? 'key-1',
    tenantId: over.tenantId ?? 'tenant-1',
    keyHash: key.keyHash,
    revokedAt: over.revokedAt ?? null,
    prefix: key.prefix,
  });
  return key.plaintext;
}

describe('ApiKeyAuthenticator', () => {
  it('resolves a valid key to its tenant', async () => {
    const store = new FakeStore();
    const plaintext = seedValidKey(store, { id: 'key-1', tenantId: 'tenant-1' });
    const auth = new ApiKeyAuthenticator(store);

    const context = await auth.authenticate(plaintext);

    expect(context).toEqual({ tenantId: 'tenant-1', apiKeyId: 'key-1' });
  });

  it('records last-used on a successful authentication (best-effort)', async () => {
    const store = new FakeStore();
    const plaintext = seedValidKey(store, { id: 'key-1' });
    const auth = new ApiKeyAuthenticator(store);

    await auth.authenticate(plaintext);
    // touchLastUsed is fire-and-forget; let the microtask run.
    await Promise.resolve();

    expect(store.touched).toEqual(['key-1']);
  });

  it('never fails a valid request when touchLastUsed throws', async () => {
    const store = new FakeStore();
    const plaintext = seedValidKey(store);
    vi.spyOn(store, 'touchLastUsed').mockRejectedValue(new Error('write failed'));
    const auth = new ApiKeyAuthenticator(store);

    await expect(auth.authenticate(plaintext)).resolves.toBeDefined();
  });

  it('rejects a structurally malformed credential', async () => {
    const auth = new ApiKeyAuthenticator(new FakeStore());
    await expect(auth.authenticate('not-a-key')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects an unknown prefix', async () => {
    const auth = new ApiKeyAuthenticator(new FakeStore());
    // Well-formed but nothing is stored for it.
    const plaintext = generateApiKey().plaintext;
    await expect(auth.authenticate(plaintext)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a known prefix with the wrong secret', async () => {
    const store = new FakeStore();
    const key = generateApiKey();
    store.add({
      id: 'key-1',
      tenantId: 'tenant-1',
      keyHash: key.keyHash,
      revokedAt: null,
      prefix: key.prefix,
    });
    const auth = new ApiKeyAuthenticator(store);

    // Same prefix, different secret body.
    const forged = generateApiKey();
    const collidingSecret = key.prefix + forged.plaintext.slice(-20);
    await expect(
      auth.authenticate('awk_' + collidingSecret),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a revoked key', async () => {
    const store = new FakeStore();
    const plaintext = seedValidKey(store, { revokedAt: new Date('2026-01-01T00:00:00Z') });
    const auth = new ApiKeyAuthenticator(store);

    await expect(auth.authenticate(plaintext)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('does not record last-used for a rejected key', async () => {
    const store = new FakeStore();
    const auth = new ApiKeyAuthenticator(store);

    await auth.authenticate('not-a-key').catch(() => undefined);
    await Promise.resolve();

    expect(store.touched).toEqual([]);
  });
});
