/**
 * Static safety checks for the manual pilot dry-run workflow
 * (`.github/workflows/pilot-dry-run.yml`). The workflow cannot run here, so these assert
 * the invariants that keep it safe:
 *   - manual-only (workflow_dispatch; no push/pull_request/schedule), so it can never run
 *     during PR CI or on merge;
 *   - it runs the merged CLI with NO `--commit` anywhere (dry-run only);
 *   - inputs are UUID-validated and passed as env vars, not shell-interpolated;
 *   - the optional keyring is forwarded only when set (never "" to the Zod parser), reusing
 *     worker-free.yml's handling; no Anthropic/LLM or GitHub-OAuth secrets are supplied.
 * No real credentials are involved.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/pilot-dry-run.yml'), 'utf8');

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

describe('pilot-dry-run.yml — manual-only trigger and toolchain', () => {
  it('is triggered ONLY by workflow_dispatch (no push/pull_request/schedule)', () => {
    expect(onBlock).toContain('workflow_dispatch:');
    expect(onBlock).not.toMatch(/\n\s*push:/);
    expect(onBlock).not.toMatch(/\n\s*pull_request:/);
    expect(onBlock).not.toMatch(/\n\s*schedule:/);
  });

  it('declares the two required UUID inputs', () => {
    expect(onBlock).toContain('tenant_id:');
    expect(onBlock).toContain('connection_id:');
    expect(onBlock.match(/required: true/g) ?? []).toHaveLength(2);
  });

  it('uses least privilege, the worker-free environment, and a scoped concurrency group', () => {
    expect(workflow).toMatch(/permissions:\n\s+contents: read/);
    expect(workflow).toContain('environment: worker-free');
    expect(workflow).toContain('group: pilot-dry-run');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('timeout-minutes: 10');
  });

  it('reuses the established Node 24 / pnpm / frozen-lockfile / build toolchain', () => {
    expect(workflow).toContain('uses: pnpm/action-setup@v6');
    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain('pnpm install --frozen-lockfile');
    expect(workflow).toContain('pnpm build');
  });

  it('validates both inputs as UUIDs before anything else', () => {
    const validate = stepBlock('Validate inputs are UUIDs');
    expect(validate).toContain('TENANT_ID: ${{ inputs.tenant_id }}');
    expect(validate).toContain('CONNECTION_ID: ${{ inputs.connection_id }}');
    expect(validate).toMatch(/\[0-9a-fA-F\]\{8\}/); // a UUID regex
    expect(validate).toContain('::error::tenant_id must be a UUID');
  });
});

describe('pilot-dry-run.yml — dry-run only, safe secret handling', () => {
  it('runs the merged CLI without a --commit argument or a commit input', () => {
    expect(workflow).toContain('pnpm github:prepare-pilot "${TENANT_ID}" "${CONNECTION_ID}"');
    // --commit must never appear on the CLI invocation line (comments may mention it).
    expect(workflow).not.toMatch(/github:prepare-pilot[^\n]*--commit/);
    // and there must be no `commit` dispatch input/flag.
    expect(onBlock).not.toMatch(/commit/i);
  });

  it('passes the dispatch inputs as env, not raw shell interpolation, in the run step', () => {
    const dry = stepBlock('Pilot authoring dry run (no --commit)');
    expect(dry).toContain('TENANT_ID: ${{ inputs.tenant_id }}');
    expect(dry).toContain('CONNECTION_ID: ${{ inputs.connection_id }}');
    // The command line itself must use the shell env vars, never `${{ inputs.* }}`.
    expect(dry).toMatch(/pnpm github:prepare-pilot "\$\{TENANT_ID\}" "\$\{CONNECTION_ID\}"/);
  });

  it('supplies exactly the prod env parseEnv needs, from worker-free secrets', () => {
    expect(workflow).toContain('NODE_ENV: production');
    expect(workflow).toContain('HOST: 0.0.0.0');
    expect(workflow).toContain('APP_ORIGIN: https://automation-7d1c.onrender.com');
    expect(workflow).toContain('LOG_LEVEL: silent');
    expect(workflow).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
    expect(workflow).toContain('CREDENTIAL_ENCRYPTION_KEY: ${{ secrets.CREDENTIAL_ENCRYPTION_KEY }}');
  });

  it('forwards the optional keyring only when set, never as an empty-string binding', () => {
    const cfg = stepBlock('Resolve optional keyring configuration');
    expect(cfg).toContain('OPT_CREDENTIAL_ENCRYPTION_KEYS: ${{ secrets.CREDENTIAL_ENCRYPTION_KEYS }}');
    expect(cfg).toContain('if [ -n "${OPT_CREDENTIAL_ENCRYPTION_KEYS}" ]; then');
    expect(cfg).toContain('CREDENTIAL_ENCRYPTION_KEYS<<__PILOT_ENV_EOF__');
    expect(cfg).toContain('>> "${GITHUB_ENV}"');
    // The real runtime name is never bound directly to an expression (that passes "" when unset).
    expect(workflow).not.toMatch(/\n\s*CREDENTIAL_ENCRYPTION_KEYS:\s*\$\{\{/);
  });

  it('supplies no LLM/Anthropic or GitHub-OAuth-client secrets (unneeded for a dry run)', () => {
    expect(workflow).not.toContain('ANTHROPIC');
    expect(workflow).not.toContain('OAUTH_GH_');
    expect(workflow).not.toContain('GITHUB_CLIENT');
  });

  it('never traces or echoes a secret value to stdout', () => {
    expect(workflow).not.toMatch(/^\s*set\s+-x/m);
    expect(workflow).not.toMatch(/echo[^\n]*\$\{\{\s*secrets\./);
  });
});

describe('pilot-dry-run.yml — production-secret hardening', () => {
  it('runs the secret-bearing job only on the default branch (main)', () => {
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
  });

  it('masks the validated tenant/connection identifiers before the CLI runs', () => {
    const validate = stepBlock('Validate inputs are UUIDs');
    expect(validate).toContain('::add-mask::${TENANT_ID}');
    expect(validate).toContain('::add-mask::${CONNECTION_ID}');
  });

  it('describes the inputs as non-secret identifiers, not credentials', () => {
    expect(onBlock).toContain('non-secret identifier');
    expect(onBlock).not.toContain('entered privately');
  });

  it('documents that the worker-free Environment must be restricted to main', () => {
    expect(workflow).toMatch(/deployment branches to .?main/);
  });
});
