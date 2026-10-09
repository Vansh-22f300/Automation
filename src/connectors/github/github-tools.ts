/**
 * The GitHub tool definitions: strict argument schemas bound to the GitHub
 * connectors. The schemas are `.strict()`, so any extra field — a model trying to
 * smuggle a `connectionId`, `tenantId`, `token`, `url`, or raw request body — is
 * rejected by validation before any connection is resolved, decrypted, or any
 * GitHub call is made. The connection is chosen by trusted platform config via the
 * executor's `connectionRef`, never by these arguments.
 *
 * `owner`/`repo` are additionally charset- and length-bounded so a value cannot
 * carry a path separator or query into the (otherwise fixed) issue URL.
 */

import { z } from 'zod';

import type { ToolDefinition } from '@/domain/tool.js';
import { GITHUB_PROVIDER } from '@/oauth/providers/index.js';

import type {
  GithubCreateIssueArgs,
  GithubCreateIssueConnector,
  GithubGetUserArgs,
  GithubUserConnector,
} from './github-connector.js';

export const GITHUB_GET_AUTHENTICATED_USER_TOOL = 'github_get_authenticated_user';
export const GITHUB_CREATE_ISSUE_TOOL = 'github_create_issue';

/** No arguments: the connection is trusted config, not a tool argument. */
export const githubGetAuthenticatedUserSchema = z.object({}).strict();

/**
 * Strict create-issue arguments. `owner` is a GitHub login/org (alphanumeric and
 * hyphen); `repo` is a repository name (alphanumeric, dot, underscore, hyphen);
 * `title` is required; `body` optional. No field can select a connection or a URL.
 */
export const githubCreateIssueSchema = z
  .object({
    owner: z.string().min(1).max(39).regex(/^[A-Za-z0-9-]+$/),
    repo: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
    title: z.string().min(1).max(256),
    body: z.string().max(65_536).optional(),
  })
  .strict();

/** Build the `github_get_authenticated_user` tool, binding its schema to a connector. */
export function createGithubGetUserTool(
  connector: GithubUserConnector,
): ToolDefinition<GithubGetUserArgs> {
  return {
    name: GITHUB_GET_AUTHENTICATED_USER_TOOL,
    description:
      'Return the authenticated GitHub user (id, login, display name) for the ' +
      'connected GitHub account. Takes no arguments; the GitHub connection is chosen ' +
      'by trusted platform configuration, not by this tool.',
    provider: GITHUB_PROVIDER,
    inputSchema: githubGetAuthenticatedUserSchema as z.ZodType<GithubGetUserArgs>,
    connector,
  };
}

/** Build the `github_create_issue` tool, binding its schema to a connector. */
export function createGithubCreateIssueTool(
  connector: GithubCreateIssueConnector,
): ToolDefinition<GithubCreateIssueArgs> {
  return {
    name: GITHUB_CREATE_ISSUE_TOOL,
    description:
      'Open an issue on a public GitHub repository. Requires a GitHub connection, ' +
      'chosen by trusted platform configuration, not by these arguments.',
    provider: GITHUB_PROVIDER,
    inputSchema: githubCreateIssueSchema,
    connector,
  };
}
