/**
 * Static safety checks for the manual verify workflow
 * (`.github/workflows/verify-connection-decrypt.yml`).
 *
 * Asserts the invariants that keep it safe and isolated: manual-only (no schedule),
 * takes the two UUID inputs, runs in the `worker-free` environment with its own
 * concurrency group, binds the untrusted inputs to env (never interpolated into the
 * shell), requires + conditionally forwards the keyring without echoing it, and runs
 * the compiled read-only CLI. No real credentials involved.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const wf = readFileSync(resolve(repoRoot, '.github/workflows/verify-connection-decrypt.yml'), 'utf8');

describe('verify-connection-decrypt.yml', () => {
  it('is manual-only and isolated from the scheduled worker', () => {
    expect(wf).toContain('workflow_dispatch:');
    expect(wf).not.toMatch(/^\s*schedule:/m); // no cron — cannot run on a schedule
    expect(wf).toContain('group: verify-connection-decrypt'); // its own concurrency group
    expect(wf).not.toContain('group: worker-free'); // not the worker's group
  });

  it('takes the two UUID inputs and runs in the worker-free environment', () => {
    expect(wf).toContain('tenant_id:');
    expect(wf).toContain('connection_id:');
    expect(wf).toContain('environment: worker-free');
  });

  it('binds inputs to env and never interpolates them into the shell (injection-safe)', () => {
    expect(wf).toContain('TENANT_ID: ${{ inputs.tenant_id }}');
    expect(wf).toContain('CONNECTION_ID: ${{ inputs.connection_id }}');
    expect(wf).toContain('node dist/cli/verify-connection-decrypt.js "${TENANT_ID}" "${CONNECTION_ID}"');
    // `${{ inputs.* }}` must appear ONLY as env bindings, never inside a run command.
    expect(wf).not.toMatch(/node[^\n]*\$\{\{\s*inputs\./);
    expect(wf).toMatch(/=~ \$\{uuid\}/); // UUID shape validated in-shell before running
  });

  it('requires + forwards the keyring safely and never echoes a secret', () => {
    expect(wf).toContain('OPT_CREDENTIAL_ENCRYPTION_KEYS: ${{ secrets.CREDENTIAL_ENCRYPTION_KEYS }}');
    expect(wf).toContain('CREDENTIAL_ENCRYPTION_KEYS<<__VERIFY_ENV_EOF__');
    expect(wf).toContain('>> "${GITHUB_ENV}"');
    expect(wf).toContain('exit 1'); // fail fast when the keyring is unset
    expect(wf).toContain('LOG_LEVEL: silent');
    expect(wf).not.toMatch(/^\s*set\s+-x/m);
    expect(wf).not.toMatch(/echo[^\n]*\$\{\{\s*secrets\./);
    // The real env name is never bound directly to a secret expression ("" vs absent).
    expect(wf).not.toMatch(/\n\s*CREDENTIAL_ENCRYPTION_KEYS:\s*\$\{\{/);
  });
});
