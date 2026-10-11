/**
 * Offline unit tests for the `github:prepare-pilot` authoring CLI. No database and no real
 * repositories: fake metadata/duplicate/create seams. They prove the pilot binds ONLY the
 * read tool (never github_create_issue), defaults to a no-write dry run, authors an ACTIVE
 * webhook workflow only on --commit, verifies connection ownership via metadata, refuses a
 * duplicate, enqueues nothing, validates its ids, and sanitizes failures.
 */
import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  buildGithubPilotDefinition,
  isValidId,
  prepareGithubPilot,
  runCli,
  PILOT_MAX_OUTPUT_TOKENS,
  PILOT_MAX_TOOL_ROUNDS,
  PILOT_WEBHOOK_SOURCE,
  PILOT_WORKFLOW_NAME,
  type GithubPilotCliDeps,
  type PrepareOptions,
} from '@/cli/create-github-pilot.js';
import { GITHUB_CREATE_ISSUE_TOOL, GITHUB_GET_AUTHENTICATED_USER_TOOL } from '@/connectors/github/index.js';
import type { ConnectionMetadata } from '@/domain/connection.js';
import { parseWorkflowDefinition } from '@/domain/workflow-definition.js';

const TID = '018f0000-0000-7000-8000-000000000001';
const CID = '018f0000-0000-7000-8000-0000000000c0';

function collect(): { stream: NodeJS.WritableStream; text: () => string } {
  let buf = '';
  const stream = new Writable({ write(chunk, _enc, cb) { buf += String(chunk); cb(); } });
  return { stream, text: () => buf };
}

function ghMeta(status: ConnectionMetadata['status'] = 'active', provider = 'github'): ConnectionMetadata {
  return { id: CID, provider, name: 'octocat', status, metadata: {}, createdAt: new Date(0), updatedAt: new Date(0), lastUsedAt: null };
}

const createdStub = { workflow: { id: 'wf-1', name: PILOT_WORKFLOW_NAME }, version: { id: 'v-1', version: 1, isActive: true } } as never;

function baseOpts(over: Partial<PrepareOptions> = {}): PrepareOptions {
  return {
    getMetadata: async () => ghMeta(),
    findExistingPilot: async () => null,
    createWorkflow: vi.fn(async () => createdStub),
    tenantId: TID,
    connectionId: CID,
    commit: false,
    stdout: collect().stream,
    ...over,
  };
}

describe('buildGithubPilotDefinition', () => {
  it('authors one llm step with ONLY the read tool and the safe limits (no github_create_issue)', () => {
    const def = buildGithubPilotDefinition(CID);
    const parsed = parseWorkflowDefinition(def); // validates through the real domain schema
    expect(parsed.steps).toHaveLength(1);
    const step = parsed.steps[0]!;
    if (step.type !== 'llm') throw new Error('expected an llm step');
    expect(step.config.tools).toEqual([{ name: GITHUB_GET_AUTHENTICATED_USER_TOOL, connection_id: CID }]);
    expect(step.config.max_tool_rounds).toBe(PILOT_MAX_TOOL_ROUNDS);
    expect(step.config.max_output_tokens).toBe(PILOT_MAX_OUTPUT_TOKENS);
    expect(step.config.system).not.toContain('{{');
    // The write tool appears nowhere in the authored definition.
    expect(JSON.stringify(def)).not.toContain(GITHUB_CREATE_ISSUE_TOOL);
  });
});

describe('prepareGithubPilot — dry run (default) writes nothing', () => {
  it('prints the plan and never calls createWorkflow', async () => {
    const out = collect();
    const createWorkflow = vi.fn(async () => createdStub);
    const v = await prepareGithubPilot(baseOpts({ commit: false, createWorkflow, stdout: out.stream }));
    expect(v).toMatchObject({ outcome: 'dry_run', reason: 'ok_dry_run', exitCode: 0 });
    expect(createWorkflow).not.toHaveBeenCalled();
    expect(out.text()).toContain('DRY RUN');
    expect(out.text()).toContain(GITHUB_GET_AUTHENTICATED_USER_TOOL);
    expect(out.text()).not.toContain(GITHUB_CREATE_ISSUE_TOOL);
  });
});

describe('prepareGithubPilot — commit authors an active workflow, enqueues nothing', () => {
  it('calls createWorkflow once with the ACTIVE webhook pilot input', async () => {
    const out = collect();
    const createWorkflow = vi.fn(async (_input: Parameters<PrepareOptions['createWorkflow']>[0]) => createdStub);
    const v = await prepareGithubPilot(baseOpts({ commit: true, createWorkflow, stdout: out.stream }));
    expect(v).toMatchObject({ outcome: 'created', reason: 'created', workflowId: 'wf-1', exitCode: 0 });
    expect(createWorkflow).toHaveBeenCalledTimes(1);
    const input = createWorkflow.mock.calls[0]![0];
    expect(input.name).toBe(PILOT_WORKFLOW_NAME);
    expect(input.triggerType).toBe('webhook');
    expect(input.triggerConfig).toEqual({ source: PILOT_WEBHOOK_SOURCE });
    expect(input.activate).toBe(true);
    expect(JSON.stringify(input.definition)).toContain(GITHUB_GET_AUTHENTICATED_USER_TOOL);
    expect(JSON.stringify(input.definition)).not.toContain('github_create_issue');
    expect(out.text()).toContain('CREATED');
    expect(out.text()).toContain('NO run has been enqueued');
  });
});

describe('prepareGithubPilot — connection ownership checks never write', () => {
  it('fails connection_not_found when metadata is null (wrong tenant or missing)', async () => {
    const createWorkflow = vi.fn(async () => createdStub);
    const v = await prepareGithubPilot(baseOpts({ getMetadata: async () => null, commit: true, createWorkflow }));
    expect(v).toMatchObject({ outcome: 'fail', reason: 'connection_not_found', exitCode: 1 });
    expect(createWorkflow).not.toHaveBeenCalled();
  });
  it('fails wrong_provider for a non-github connection', async () => {
    const v = await prepareGithubPilot(baseOpts({ getMetadata: async () => ghMeta('active', 'slack'), commit: true }));
    expect(v).toMatchObject({ outcome: 'fail', reason: 'wrong_provider', exitCode: 1 });
  });
  it('fails connection_not_active for a disabled connection', async () => {
    const v = await prepareGithubPilot(baseOpts({ getMetadata: async () => ghMeta('disabled'), commit: true }));
    expect(v).toMatchObject({ outcome: 'fail', reason: 'connection_not_active', exitCode: 1 });
  });
});

describe('prepareGithubPilot — duplicate + error safety', () => {
  it('refuses to duplicate an existing pilot and does not write', async () => {
    const out = collect();
    const createWorkflow = vi.fn(async () => createdStub);
    const v = await prepareGithubPilot(
      baseOpts({ findExistingPilot: async () => 'wf-existing', commit: true, createWorkflow, stdout: out.stream }),
    );
    expect(v).toMatchObject({ outcome: 'fail', reason: 'pilot_already_exists', workflowId: 'wf-existing', exitCode: 1 });
    expect(createWorkflow).not.toHaveBeenCalled();
    expect(out.text()).toContain('wf-existing');
  });
  it('sanitizes an unexpected error to a typed code without leaking it', async () => {
    const out = collect();
    const v = await prepareGithubPilot(
      baseOpts({ getMetadata: async () => { throw new Error('raw-boom-detail'); }, stdout: out.stream }),
    );
    expect(v).toMatchObject({ outcome: 'fail', reason: 'error', errorCode: 'unexpected_error', exitCode: 1 });
    expect(out.text()).not.toContain('raw-boom-detail');
  });
});

const fakeDb = (close = vi.fn(async () => undefined)) =>
  ({ db: {}, verifyConnection: vi.fn(async () => undefined), close } as never);

describe('runCli — argument validation, flags, and db lifecycle', () => {
  it('rejects non-UUID args, returns 1, and never opens a database', async () => {
    const createDatabase = vi.fn();
    const code = await runCli(
      { argv: ['nope', 'nah'], stdout: collect().stream, stderr: collect().stream },
      { loadEnv: vi.fn(), createLogger: vi.fn(), createDatabase, run: vi.fn() } as unknown as GithubPilotCliDeps,
    );
    expect(code).toBe(1);
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it('defaults to commit=false (dry run) and always closes the database', async () => {
    const close = vi.fn(async () => undefined);
    const run = vi.fn(async (_input: { commit: boolean }) => ({ outcome: 'dry_run', reason: 'ok_dry_run', exitCode: 0 }) as const);
    const code = await runCli(
      { argv: [TID, CID], stdout: collect().stream, stderr: collect().stream },
      { loadEnv: () => ({} as never), createLogger: () => ({} as never), createDatabase: () => fakeDb(close), run },
    );
    expect(code).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].commit).toBe(false);
  });

  it('passes commit=true only when --commit is supplied', async () => {
    const run = vi.fn(async (_input: { commit: boolean }) => ({ outcome: 'created', reason: 'created', exitCode: 0 }) as const);
    const code = await runCli(
      { argv: [TID, CID, '--commit'], stdout: collect().stream, stderr: collect().stream },
      { loadEnv: () => ({} as never), createLogger: () => ({} as never), createDatabase: () => fakeDb(), run },
    );
    expect(code).toBe(0);
    expect(run.mock.calls[0]![0].commit).toBe(true);
  });
});

describe('isValidId', () => {
  it('accepts a UUID and rejects junk', () => {
    expect(isValidId(TID)).toBe(true);
    for (const bad of [undefined, '', 'x', `${TID}x`, TID.slice(0, -1)]) {
      expect(isValidId(bad as string | undefined)).toBe(false);
    }
  });
});
