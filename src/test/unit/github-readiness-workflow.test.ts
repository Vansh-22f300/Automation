/**
 * Static safety checks for the manual GitHub readiness workflow
 * (`.github/workflows/github-readiness.yml`): manual-only, main-guarded, confirmation-gated;
 * runs ONLY the hardcoded `github:get-user-smoke` CLI with its two masked UUID args (no
 * --commit, no other tool); reuses worker-free DATABASE_URL + keyring + OAuth forwarding; and
 * documents that it is not database-read-only. No real credentials are involved.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// Normalize CRLF→LF so `\n`-based slicing is robust on Windows checkouts.
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/github-readiness.yml'), 'utf8').replace(/\r\n/g, '\n');

function stepBlock(name: string): string {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  expect(start, `step "${name}" present`).toBeGreaterThanOrEqual(0);
  const rest = workflow.slice(start + marker.length);
  const nextRel = rest.indexOf('\n      - name: ');
  return nextRel === -1 ? workflow.slice(start) : workflow.slice(start, start + marker.length + nextRel);
}

const onBlock = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\npermissions:'));

describe('github-readiness.yml — manual-only, main guard, confirmation gate', () => {
  it('is triggered ONLY by workflow_dispatch (no push/pull_request/schedule/workflow_run)', () => {
    expect(onBlock).toContain('workflow_dispatch:');
    expect(onBlock).not.toMatch(/\n\s*push:/);
    expect(onBlock).not.toMatch(/\n\s*pull_request:/);
    expect(onBlock).not.toMatch(/\n\s*schedule:/);
    expect(workflow).not.toContain('workflow_run:');
  });

  it('declares three inputs and runs the secret-bearing job only on main', () => {
    expect(onBlock).toContain('tenant_id:');
    expect(onBlock).toContain('connection_id:');
    expect(onBlock).toContain('confirmation:');
    expect(onBlock.match(/required: true/g) ?? []).toHaveLength(3);
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
  });

  it('reuses least privilege, worker-free env, toolchain, and a scoped concurrency group', () => {
    expect(workflow).toMatch(/permissions:\n\s+contents: read/);
    expect(workflow).toContain('environment: worker-free');
    expect(workflow).toContain('uses: pnpm/action-setup@v6');
    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain('pnpm install --frozen-lockfile');
    expect(workflow).toContain('group: github-readiness');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('timeout-minutes: 10');
  });

  it('validates ids + the exact confirmation phrase, then masks the ids, before the CLI', () => {
    const validate = stepBlock('Validate inputs and confirmation');
    expect(validate).toMatch(/\[0-9a-fA-F\]\{8\}/);
    expect(validate).toContain('!= "RUN_GITHUB_READ_ONLY_SMOKE"');
    expect(validate).toContain('::add-mask::${TENANT_ID}');
    expect(validate).toContain('::add-mask::${CONNECTION_ID}');
  });
});

describe('github-readiness.yml — hardcoded read-only smoke, safe secrets', () => {
  it('runs ONLY the hardcoded read-only smoke CLI with its two UUID args and no extra flag', () => {
    expect(workflow).toMatch(/pnpm github:get-user-smoke "\$\{TENANT_ID\}" "\$\{CONNECTION_ID\}"/);
    expect(workflow).not.toMatch(/github:get-user-smoke[^\n]*--/); // no --commit or any flag on the invocation
    expect(workflow).not.toContain('github:prepare-pilot');
    expect(workflow).not.toContain('llm:readiness');
    expect(workflow).not.toContain('dist/worker/main.js');
    expect(workflow).not.toContain('curl');
  });

  it('reuses worker-free DATABASE_URL + keyring + OAuth forwarding, never empty-string binds', () => {
    expect(workflow).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
    expect(workflow).toContain('CREDENTIAL_ENCRYPTION_KEY: ${{ secrets.CREDENTIAL_ENCRYPTION_KEY }}');
    const cfg = stepBlock('Resolve optional OAuth + keyring configuration');
    expect(cfg).toContain('OPT_CREDENTIAL_ENCRYPTION_KEYS: ${{ secrets.CREDENTIAL_ENCRYPTION_KEYS }}');
    expect(cfg).toContain('OPT_GITHUB_CLIENT_ID: ${{ vars.OAUTH_GH_CLIENT_ID }}');
    expect(cfg).toContain('OPT_GITHUB_CLIENT_SECRET: ${{ secrets.OAUTH_GH_CLIENT_SECRET }}');
    expect(workflow).not.toMatch(/\n\s*CREDENTIAL_ENCRYPTION_KEYS:\s*\$\{\{/);
    expect(workflow).not.toMatch(/\n\s*GITHUB_CLIENT_ID:\s*\$\{\{/);
    // Actions reserves the GITHUB_ prefix for secret/variable names.
    expect(workflow).not.toMatch(/\$\{\{\s*(?:vars|secrets)\.GITHUB_/);
  });

  it('documents that a run is not database-read-only, and no secret is echoed', () => {
    expect(workflow).toMatch(/not database-read-only/i);
    expect(workflow).toMatch(/last_used_at/);
    expect(workflow).not.toMatch(/^\s*set\s+-x/m);
    expect(workflow).not.toMatch(/echo[^\n]*\$\{\{\s*secrets\./);
  });
});
