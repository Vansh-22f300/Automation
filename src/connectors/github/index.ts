/**
 * GitHub connector wiring. One place that assembles the transport → connectors →
 * tools → registry chain, so the worker, the CLI, and tests build it identically
 * (mirrors `connectors/slack/index.ts`).
 *
 * Nothing here is token-aware: an access token lives only in an encrypted connection
 * and is decrypted at the execution boundary, then kept fresh by the refreshing
 * resolver, before a connector ever sees it. The finalizer and revoker (the OAuth
 * callback / disconnect halves) are exported here too so the API server can wire
 * them without reaching into individual files.
 */

import { ToolRegistry } from '@/domain/tool-registry.js';
import type { Logger } from '@/observability/logger.js';

import { createFetchGithubTransport } from './github-client.js';
import type { GithubTransport } from './github-client.js';
import { GithubCreateIssueConnector, GithubUserConnector } from './github-connector.js';
import { createGithubCreateIssueTool, createGithubGetUserTool } from './github-tools.js';

export interface GithubToolsOptions {
  /** Transport to use; defaults to the real fetch-based GitHub client. */
  readonly transport?: GithubTransport;
  /** Metadata-only logger passed to the connectors. */
  readonly logger?: Logger;
}

/** Register the GitHub tools onto an existing registry (so one registry holds all providers). */
export function registerGithubTools(registry: ToolRegistry, options: GithubToolsOptions = {}): ToolRegistry {
  const transport = options.transport ?? createFetchGithubTransport();
  const connectorOptions = {
    transport,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  };
  const userConnector = new GithubUserConnector(connectorOptions);
  const issueConnector = new GithubCreateIssueConnector(connectorOptions);
  return registry
    .register(createGithubGetUserTool(userConnector))
    .register(createGithubCreateIssueTool(issueConnector));
}

/** Build a fresh {@link ToolRegistry} containing exactly the GitHub tools. */
export function createGithubToolRegistry(options: GithubToolsOptions = {}): ToolRegistry {
  return registerGithubTools(new ToolRegistry(), options);
}

export { createFetchGithubTransport, GITHUB_API_VERSION, GITHUB_USER_AGENT } from './github-client.js';
export type { GithubTransport, GithubHttpResponse, GithubCreateIssueRequest } from './github-client.js';
export { GithubUserConnector, GithubCreateIssueConnector } from './github-connector.js';
export type { GithubCreateIssueArgs, GithubGetUserArgs, GithubIssueResult } from './github-connector.js';
export {
  GITHUB_GET_AUTHENTICATED_USER_TOOL,
  GITHUB_CREATE_ISSUE_TOOL,
  githubCreateIssueSchema,
  githubGetAuthenticatedUserSchema,
  createGithubGetUserTool,
  createGithubCreateIssueTool,
} from './github-tools.js';
export { GithubConnectionFinalizer } from './github-finalizer.js';
export type { GithubConnectionFinalizerOptions } from './github-finalizer.js';
export { GithubTokenRevoker } from './github-revoker.js';
export type { GithubTokenRevokerOptions } from './github-revoker.js';
export { parseGithubIdentity } from './github-identity.js';
export type { GithubIdentity } from './github-identity.js';
