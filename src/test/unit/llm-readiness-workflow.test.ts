/**
 * Static safety checks for the manual LLM readiness workflow
 * (`.github/workflows/llm-readiness.yml`): manual-only, main-guarded, confirmation-gated;
 * runs ONLY `pnpm llm:readiness`; supplies ONLY the three ANTHROPIC vars (no DATABASE_URL,
 * keyring, or OAuth); discloses the billable LLM request; and accepts no arbitrary model,
 * URL, prompt, or command input. No real credentials are involved.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// Normalize CRLF→LF so `\n`-based slicing is robust on Windows checkouts.
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/llm-readiness.yml'), 'utf8').replace(/\r\n/g, '\n');

function stepBlock(name: string): string {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  expect(start, `step "${name}" present`).toBeGreaterThanOrEqual(0);
  const rest = workflow.slice(start + marker.length);
  const nextRel = rest.indexOf('\n      - name: ');
  return nextRel === -1 ? workflow.slice(start) : workflow.slice(start, start + marker.length + nextRel);
}

const onBlock = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\npermissions:'));

describe('llm-readiness.yml — manual-only, main guard, confirmation gate', () => {
  it('is triggered ONLY by workflow_dispatch (no push/pull_request/schedule/workflow_run)', () => {
    expect(onBlock).toContain('workflow_dispatch:');
    expect(onBlock).not.toMatch(/\n\s*push:/);
    expect(onBlock).not.toMatch(/\n\s*pull_request:/);
    expect(onBlock).not.toMatch(/\n\s*schedule:/);
    expect(workflow).not.toContain('workflow_run:');
  });

  it('accepts ONLY a confirmation input — no arbitrary model, url, prompt, or command', () => {
    expect(onBlock).toContain('confirmation:');
    expect(onBlock.match(/required: true/g) ?? []).toHaveLength(1);
    expect(onBlock).not.toContain('tenant_id');
    expect(onBlock).not.toMatch(/\n\s+(model|url|base_url|prompt|command):/);
  });

  it('runs the secret-bearing job only on main, with least privilege and the toolchain', () => {
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toMatch(/permissions:\n\s+contents: read/);
    expect(workflow).toContain('environment: worker-free');
    expect(workflow).toContain('uses: pnpm/action-setup@v6');
    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain('pnpm install --frozen-lockfile');
    expect(workflow).toContain('group: llm-readiness');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('timeout-minutes: 10');
  });

  it('requires the exact confirmation phrase', () => {
    const validate = stepBlock('Validate confirmation');
    expect(validate).toContain('!= "RUN_MINIMAL_LLM_SMOKE"');
    expect(validate).toContain('CONFIRMATION: ${{ inputs.confirmation }}');
  });
});

describe('llm-readiness.yml — runs the strict CLI with only ANTHROPIC config', () => {
  it('runs the hardcoded llm:readiness command', () => {
    expect(workflow).toContain('pnpm llm:readiness');
    expect(workflow).not.toContain('github:'); // no GitHub CLI
    expect(workflow).not.toContain('dist/worker/main.js');
    expect(workflow).not.toContain('curl');
  });

  it('supplies ONLY the three ANTHROPIC vars from their worker-free sources', () => {
    const run = stepBlock('Minimal LLM readiness (one structured request)');
    expect(run).toContain('ANTHROPIC_AUTH_TOKEN: ${{ secrets.ANTHROPIC_AUTH_TOKEN }}');
    expect(run).toContain('ANTHROPIC_BASE_URL: ${{ vars.ANTHROPIC_BASE_URL }}');
    expect(run).toContain('ANTHROPIC_MODEL: ${{ vars.ANTHROPIC_MODEL }}');
    // No database, keyring, or OAuth config is bound.
    expect(workflow).not.toContain('secrets.DATABASE_URL');
    expect(workflow).not.toContain('CREDENTIAL_ENCRYPTION');
    expect(workflow).not.toContain('OAUTH_GH');
  });

  it('discloses the billable LLM request and never echoes a secret', () => {
    expect(workflow).toMatch(/billable/i);
    expect(workflow).not.toMatch(/^\s*set\s+-x/m);
    expect(workflow).not.toMatch(/echo[^\n]*\$\{\{\s*secrets\./);
  });
});
