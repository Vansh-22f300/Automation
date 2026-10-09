/**
 * A fake GitHub transport for tests. Records the exact request (create-issue input
 * and the access token it received) and returns a scripted {@link GithubHttpResponse}
 * per operation — or throws a scripted transport error to simulate network/timeout.
 *
 * The normal test suite MUST NOT reach the real GitHub API; this is how. It also lets
 * a test assert that the access token reaches the transport and nowhere else.
 */

import type {
  GithubCreateIssueRequest,
  GithubHttpResponse,
  GithubTransport,
} from '@/connectors/github/github-client.js';

export interface FakeGithubTransportOptions {
  /** Response for `getAuthenticatedUser`. Defaults to a valid identity. */
  readonly userResponse?: GithubHttpResponse;
  /** Response for `createIssue`. Defaults to a created issue. */
  readonly issueResponse?: GithubHttpResponse;
  /** If set, `getAuthenticatedUser` rejects with this (simulates transport failure). */
  readonly throwOnUser?: Error;
  /** If set, `createIssue` rejects with this (simulates transport failure). */
  readonly throwOnIssue?: Error;
}

export class FakeGithubTransport implements GithubTransport {
  userCalls = 0;
  issueCalls = 0;
  lastToken: string | undefined;
  lastIssueInput: GithubCreateIssueRequest | undefined;

  private readonly userResponse: GithubHttpResponse;
  private readonly issueResponse: GithubHttpResponse;
  private readonly throwOnUser: Error | undefined;
  private readonly throwOnIssue: Error | undefined;

  constructor(options: FakeGithubTransportOptions = {}) {
    this.userResponse = options.userResponse ?? {
      status: 200,
      body: { id: 42, login: 'octocat', name: 'The Octocat' },
    };
    this.issueResponse = options.issueResponse ?? {
      status: 201,
      body: {
        number: 7,
        id: 1001,
        html_url: 'https://github.com/octocat/hello-world/issues/7',
        state: 'open',
        title: 'Found a bug',
      },
    };
    this.throwOnUser = options.throwOnUser;
    this.throwOnIssue = options.throwOnIssue;
  }

  getAuthenticatedUser(accessToken: string): Promise<GithubHttpResponse> {
    this.userCalls += 1;
    this.lastToken = accessToken;
    if (this.throwOnUser !== undefined) return Promise.reject(this.throwOnUser);
    return Promise.resolve(this.userResponse);
  }

  createIssue(input: GithubCreateIssueRequest, accessToken: string): Promise<GithubHttpResponse> {
    this.issueCalls += 1;
    this.lastToken = accessToken;
    this.lastIssueInput = input;
    if (this.throwOnIssue !== undefined) return Promise.reject(this.throwOnIssue);
    return Promise.resolve(this.issueResponse);
  }
}
