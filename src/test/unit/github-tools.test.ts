/**
 * GitHub tool-schema and transport unit tests.
 *
 * The schemas are the first security gate: strict, so no extra field (a smuggled
 * connectionId/url/token) survives, and owner/repo are charset-bounded so they cannot
 * carry a path separator. The transport is the confinement: fixed base URL, fixed
 * path templates with encoded segments, and the required GitHub headers — a caller
 * can reach only `/user` and `/repos/{owner}/{repo}/issues`.
 */

import { describe, expect, it } from 'vitest';

import { createFetchGithubTransport } from '@/connectors/github/github-client.js';
import {
  githubCreateIssueSchema,
  githubGetAuthenticatedUserSchema,
} from '@/connectors/github/github-tools.js';

/** A minimal fetch Response stub: only status/json/headers are read by the client. */
const okResponse = (body: unknown): Response =>
  ({ status: 200, json: async () => body, headers: { get: () => null } }) as unknown as Response;

describe('GitHub transport confinement', () => {
  it('getAuthenticatedUser hits the fixed /user URL with the required headers and Bearer token', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const transport = createFetchGithubTransport({
      fetch: async (url, init) => {
        seen = { url, init };
        return okResponse({ id: 1, login: 'x' });
      },
    });
    await transport.getAuthenticatedUser('TOKEN');
    expect(seen!.url).toBe('https://api.github.com/user');
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers['accept']).toBe('application/vnd.github+json');
    expect(headers['x-github-api-version']).toBe('2022-11-28');
    expect(headers['user-agent']).toBeTruthy();
    expect(headers['authorization']).toBe('Bearer TOKEN');
  });

  it('createIssue posts to the fixed issues URL, ENCODING path segments (no injection)', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const transport = createFetchGithubTransport({
      fetch: async (url, init) => {
        seen = { url, init };
        return okResponse({ number: 1 });
      },
    });
    // Even a hostile owner/repo (space, slash) cannot open a new path segment: both are
    // percent-encoded into the one fixed template. (The tool schema also rejects these.)
    await transport.createIssue({ owner: 'a b', repo: 'c/d', title: 'T', body: 'B' }, 'TOKEN');
    expect(seen!.url).toBe('https://api.github.com/repos/a%20b/c%2Fd/issues');
    expect(seen!.init.method).toBe('POST');
    expect(JSON.parse(seen!.init.body as string)).toEqual({ title: 'T', body: 'B' });
    expect((seen!.init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});

describe('githubCreateIssueSchema (strict)', () => {
  it('accepts a well-formed issue (with and without a body)', () => {
    expect(githubCreateIssueSchema.safeParse({ owner: 'octocat', repo: 'hello-world', title: 'Bug' }).success).toBe(true);
    expect(githubCreateIssueSchema.safeParse({ owner: 'octocat', repo: 'hello.world_1', title: 'Bug', body: 'x' }).success).toBe(true);
  });

  it('rejects unknown keys — no connectionId / url / token smuggling', () => {
    expect(githubCreateIssueSchema.safeParse({ owner: 'o', repo: 'r', title: 'T', connectionId: 'c' }).success).toBe(false);
    expect(githubCreateIssueSchema.safeParse({ owner: 'o', repo: 'r', title: 'T', url: 'http://evil' }).success).toBe(false);
  });

  it('rejects an owner or repo carrying a path separator or traversal', () => {
    expect(githubCreateIssueSchema.safeParse({ owner: 'a/b', repo: 'r', title: 'T' }).success).toBe(false);
    expect(githubCreateIssueSchema.safeParse({ owner: 'o', repo: '../etc', title: 'T' }).success).toBe(false);
    expect(githubCreateIssueSchema.safeParse({ owner: 'o', repo: 'a/b', title: 'T' }).success).toBe(false);
  });

  it('requires a non-empty title', () => {
    expect(githubCreateIssueSchema.safeParse({ owner: 'o', repo: 'r', title: '' }).success).toBe(false);
  });
});

describe('githubGetAuthenticatedUserSchema (strict, no args)', () => {
  it('accepts an empty object and rejects any field', () => {
    expect(githubGetAuthenticatedUserSchema.safeParse({}).success).toBe(true);
    expect(githubGetAuthenticatedUserSchema.safeParse({ anything: 1 }).success).toBe(false);
  });
});
