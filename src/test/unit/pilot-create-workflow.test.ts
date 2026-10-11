/**
 * Static safety checks for the manual pilot CREATE workflow
 * (`.github/workflows/pilot-create.yml`). The workflow performs a real production DB write,
 * so these assert the gates that keep it safe:
 *   - manual-only (workflow_dispatch; no push/pull_request/schedule/workflow_run);
 *   - the secret-bearing job runs only on main;
 *   - an exact confirmation phrase is required and the --commit invocation is hardcoded;
 *   - UUID inputs are validated + masked and passed as env (not shell-interpolated);
 *   - worker-free DATABASE_URL + keyring handling reused; no Anthropic/OAuth secrets;
 *   - there is NO job-execution mechanism (no worker, webhook ingest, or other CLI).
 * No real credentials are involved.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// Normalize CRLF → LF so the `\n`-based slicing is robust regardless of the checkout's
// line-ending policy (git may materialize CRLF on Windows).
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/pilot-create.yml'), 'utf8').replace(/\r\n/g, '\n');

/** Slice one `- name: <name>` step block (up to the next 6-space `- name:`). */
function stepBlock(name: string): string {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  expect(start, `step "${name}" present`).toBeGreaterThanOrEqual(0);
  const rest = workflow.slice(start + marker.length);
  const nextRel = rest.indexOf('\n      - name: ');
  return nextRel === -1 ? workflow.slice(start) : workflow.slice(start, start + marker.length + nextRel);
}

/** The `on:` trigger block (up to the next top-level `permissions:`). */
const onBlock = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\npermissions:'));

describe('pilot-create.yml — manual-only trigger, main guard, confirmation gate', () => {
  it('is triggered ONLY by workflow_dispatch (no push/pull_request/schedule/workflow_run)', () => {
    expect(onBlock).toContain('workflow_dispatch:');
    expect(onBlock).not.toMatch(/\n\s*push:/);
    expect(onBlock).not.toMatch(/\n\s*pull_request:/);
    expect(onBlock).not.toMatch(/\n\s*schedule:/);
    expect(workflow).not.toContain('workflow_run:');
  });

  it('declares three required inputs incl. a confirmation phrase', () => {
    expect(onBlock).toContain('tenant_id:');
    expect(onBlock).toContain('connection_id:');
    expect(onBlock).toContain('confirmation:');
    expect(onBlock.match(/required: true/g) ?? []).toHaveLength(3);
    // Inputs are described as non-secret identifiers, not credentials.
    expect(onBlock).not.toContain('entered privately');
  });

  it('runs the secret-bearing job only on the default branch (main)', () => {
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
  });

  it('uses least privilege, the worker-free environment, toolchain, and scoped concurrency', () => {
    expect(workflow).toMatch(/permissions:\n\s+contents: read/);
    expect(workflow).toContain('environment: worker-free');
    expect(workflow).toContain('uses: pnpm/action-setup@v6');
    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain('pnpm install --frozen-lockfile');
    expect(workflow).toContain('pnpm build');
    expect(workflow).toContain('group: pilot-create');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('timeout-minutes: 10');
  });

  it('validates ids + the exact confirmation phrase, then masks the ids, before the CLI', () => {
    const validate = stepBlock('Validate inputs and confirmation');
    expect(validate).toMatch(/\[0-9a-fA-F\]\{8\}/); // UUID regex
    expect(validate).toContain('CONFIRMATION: ${{ inputs.confirmation }}');
    expect(validate).toContain('!= "CREATE_GITHUB_READ_ONLY_PILOT"');
    expect(validate).toContain('::add-mask::${TENANT_ID}');
    expect(validate).toContain('::add-mask::${CONNECTION_ID}');
  });

  it('documents that the worker-free Environment must be restricted to main', () => {
    expect(workflow).toMatch(/deployment branches to .?main/);
  });
});

describe('pilot-create.yml — production write, safe secrets, no execution path', () => {
  it('runs the hardcoded --commit invocation with inputs passed as env vars', () => {
    expect(workflow).toMatch(/pnpm github:prepare-pilot "\$\{TENANT_ID\}" "\$\{CONNECTION_ID\}" --commit/);
    const create = stepBlock('Create the pilot workflow (--commit)');
    expect(create).toContain('TENANT_ID: ${{ inputs.tenant_id }}');
    expect(create).toContain('CONNECTION_ID: ${{ inputs.connection_id }}');
  });

  it('supplies prod env from worker-free secrets + keyring handling, never an empty-string bind', () => {
    expect(workflow).toContain('NODE_ENV: production');
    expect(workflow).toContain('APP_ORIGIN: https://automation-7d1c.onrender.com');
    expect(workflow).toContain('LOG_LEVEL: silent');
    expect(workflow).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
    expect(workflow).toContain('CREDENTIAL_ENCRYPTION_KEY: ${{ secrets.CREDENTIAL_ENCRYPTION_KEY }}');
    const cfg = stepBlock('Resolve optional keyring configuration');
    expect(cfg).toContain('OPT_CREDENTIAL_ENCRYPTION_KEYS: ${{ secrets.CREDENTIAL_ENCRYPTION_KEYS }}');
    expect(cfg).toContain('>> "${GITHUB_ENV}"');
    expect(workflow).not.toMatch(/\n\s*CREDENTIAL_ENCRYPTION_KEYS:\s*\$\{\{/);
  });

  it('supplies no LLM/Anthropic or GitHub-OAuth-client secrets', () => {
    expect(workflow).not.toContain('ANTHROPIC');
    expect(workflow).not.toContain('OAUTH_GH_');
    expect(workflow).not.toContain('GITHUB_CLIENT');
  });

  it('contains NO job-execution mechanism (no worker entrypoint, HTTP call, or migration)', () => {
    expect(workflow).not.toContain('dist/worker/main.js');
    expect(workflow).not.toContain('curl');
    expect(workflow).not.toMatch(/db:migrate|drizzle-kit/);
    expect(workflow).not.toContain('github:get-user-smoke');
  });

  it('never traces or echoes a secret value to stdout', () => {
    expect(workflow).not.toMatch(/^\s*set\s+-x/m);
    expect(workflow).not.toMatch(/echo[^\n]*\$\{\{\s*secrets\./);
  });
});
