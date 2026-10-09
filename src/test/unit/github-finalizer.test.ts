/**
 * GitHub connection finalizer unit tests — with a fake transport.
 *
 * The finalizer runs at the OAuth callback: it validates `GET /user`, names the
 * connection after the GitHub login, and attaches non-secret identity metadata. These
 * tests pin that the access token reaches only the transport (never the returned
 * finalization), that the identity is authoritative, and that failures surface as the
 * OAuth error shapes the callback route maps safely — deterministic rejections as
 * permanent, transient outages as retryable.
 */

import { describe, expect, it, vi } from 'vitest';

import { GithubConnectionFinalizer } from '@/connectors/github/github-finalizer.js';
import { OAuthProviderError, OAuthProviderUnavailableError } from '@/oauth/errors.js';
import type { OAuthTokenSet } from '@/oauth/token-client.js';
import { FakeGithubTransport } from '@/test/support/fake-github-transport.js';

const ACCESS_TOKEN = 'gho_FINALIZER_SECRET';
const tokenSet: OAuthTokenSet = { accessToken: ACCESS_TOKEN, tokenType: 'bearer', scope: 'read:user public_repo' };

const finalize = (transport: FakeGithubTransport) =>
  new GithubConnectionFinalizer({ transport }).finalize({ tokenSet });

describe('GithubConnectionFinalizer', () => {
  it('names the connection after the login and keeps only non-secret identity metadata', async () => {
    const transport = new FakeGithubTransport();
    const result = await finalize(transport);
    expect(transport.lastToken).toBe(ACCESS_TOKEN);
    expect(result).toEqual({
      name: 'octocat',
      metadata: {
        provider: 'github',
        githubUserId: 42,
        login: 'octocat',
        displayName: 'The Octocat',
        scope: 'read:user public_repo',
      },
    });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
  });

  it('omits displayName when GitHub returns a null name and scope when absent', async () => {
    const transport = new FakeGithubTransport({ userResponse: { status: 200, body: { id: 7, login: 'ghost', name: null } } });
    const result = await new GithubConnectionFinalizer({ transport }).finalize({
      tokenSet: { accessToken: ACCESS_TOKEN, tokenType: 'bearer' },
    });
    expect(result).toEqual({ name: 'ghost', metadata: { provider: 'github', githubUserId: 7, login: 'ghost' } });
  });

  it('rejects a deterministic identity failure (4xx) as a permanent OAuth error', async () => {
    const e = await finalize(new FakeGithubTransport({ userResponse: { status: 401, body: { message: 'Bad credentials' } } }))
      .then(() => undefined, (err: unknown) => err);
    expect(e).toBeInstanceOf(OAuthProviderError);
    expect((e as OAuthProviderError).retryable).toBe(false);
    expect((e as OAuthProviderError).details).toMatchObject({ reason: 'identity_rejected' });
  });

  it('treats a transient identity failure (5xx) as a retryable OAuth error', async () => {
    const e = await finalize(new FakeGithubTransport({ userResponse: { status: 503, body: {} } }))
      .then(() => undefined, (err: unknown) => err);
    expect(e).toBeInstanceOf(OAuthProviderUnavailableError);
    expect((e as OAuthProviderUnavailableError).retryable).toBe(true);
  });

  it('treats a transport failure as a retryable OAuth error (token not in the cause)', async () => {
    const e = await finalize(new FakeGithubTransport({ throwOnUser: new Error('ETIMEDOUT') }))
      .then(() => undefined, (err: unknown) => err);
    expect(e).toBeInstanceOf(OAuthProviderUnavailableError);
    expect((e as OAuthProviderUnavailableError).details).toMatchObject({ reason: 'identity_unreachable' });
    expect(JSON.stringify((e as Error).message)).not.toContain(ACCESS_TOKEN);
  });

  it('rejects a malformed identity body as a permanent OAuth error', async () => {
    const e = await finalize(new FakeGithubTransport({ userResponse: { status: 200, body: { login: 'no-id' } } }))
      .then(() => undefined, (err: unknown) => err);
    expect(e).toBeInstanceOf(OAuthProviderError);
    expect((e as OAuthProviderError).details).toMatchObject({ reason: 'identity_malformed' });
  });

  it('does not log the access token', async () => {
    const info = vi.fn();
    const logger = { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as never;
    await new GithubConnectionFinalizer({ transport: new FakeGithubTransport(), logger }).finalize({ tokenSet });
    expect(JSON.stringify(info.mock.calls)).not.toContain(ACCESS_TOKEN);
  });
});
