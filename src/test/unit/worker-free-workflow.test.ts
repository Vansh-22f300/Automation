/**
 * Static safety checks for the free-mode worker workflow
 * (`.github/workflows/worker-free.yml`).
 *
 * The workflow cannot run here, so these assert the invariants that make the
 * optional v2-keyring / GitHub-OAuth wiring safe and backward-compatible:
 *   - the legacy single-key path is untouched;
 *   - optional vars are NEVER passed to the backend as empty strings (the Zod
 *     parser treats "" differently from absent), only forwarded when configured;
 *   - the GitHub pair is both-or-neither with a non-secret fail-fast;
 *   - secret values flow only into $GITHUB_ENV, never stdout, and no `set -x`;
 *   - the existing runtime (schedule, bounded session, node/pnpm, keep-alive,
 *     concurrency, APP_ORIGIN) is unchanged.
 * No real credentials are involved.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/worker-free.yml'), 'utf8');

/** Slice one `- name: <name>` step block (up to the next 6-space `- name:`). */
function stepBlock(name: string): string {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  expect(start, `step "${name}" present`).toBeGreaterThanOrEqual(0);
  const rest = workflow.slice(start + marker.length);
  const nextRel = rest.indexOf('\n      - name: ');
  return nextRel === -1 ? workflow.slice(start) : workflow.slice(start, start + marker.length + nextRel);
}

describe('worker-free.yml — existing runtime preserved', () => {
  it('keeps the schedule, concurrency, node/pnpm and bounded-session unchanged', () => {
    expect(workflow).toContain('cron: "*/5 * * * *"');
    expect(workflow).toContain('group: worker-free');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('timeout-minutes: 10');
    expect(workflow).toContain('node-version: "24"');
    expect(workflow).toContain('uses: pnpm/action-setup@v6');
    expect(workflow).toContain('timeout --signal=SIGTERM --kill-after=30s --preserve-status 240s');
    expect(workflow).toContain('node dist/worker/main.js');
  });

  it('keeps the DB secret, APP_ORIGIN and legacy single-key path intact', () => {
    expect(workflow).toContain('DATABASE_URL: ${{ secrets.DATABASE_URL }}');
    expect(workflow).toContain('APP_ORIGIN: https://automation-7d1c.onrender.com');
    expect(workflow).toContain('CREDENTIAL_ENCRYPTION_KEY: ${{ secrets.CREDENTIAL_ENCRYPTION_KEY }}');
  });

  it('keeps the best-effort keep-alive step (RENDER_API_URL-gated /healthz)', () => {
    const keepAlive = stepBlock('Keep-alive ping (best-effort)');
    expect(keepAlive).toContain('RENDER_API_URL: ${{ vars.RENDER_API_URL }}');
    expect(keepAlive).toContain('/healthz');
    expect(keepAlive).toContain('keep-alive: skipped (RENDER_API_URL not set)');
  });
});

describe('worker-free.yml — optional keyring / GitHub wiring is safe', () => {
  const cfg = stepBlock('Resolve optional OAuth + keyring configuration');

  it('reads the optional values only as OPT_ aliases from the right sources', () => {
    expect(cfg).toContain('OPT_CREDENTIAL_ENCRYPTION_KEYS: ${{ secrets.CREDENTIAL_ENCRYPTION_KEYS }}');
    // GitHub Actions reserves the GITHUB_ prefix for secret/variable NAMES, so the
    // OAuth client is sourced from OAUTH_GH_* (variable + secret), then forwarded to
    // the app's GITHUB_CLIENT_* runtime names below.
    expect(cfg).toContain('OPT_GITHUB_CLIENT_ID: ${{ vars.OAUTH_GH_CLIENT_ID }}');
    expect(cfg).toContain('OPT_GITHUB_CLIENT_SECRET: ${{ secrets.OAUTH_GH_CLIENT_SECRET }}');
  });

  it('never references a reserved GITHUB_-prefixed Actions secret/variable name', () => {
    // Actions rejects `vars.GITHUB_*` / `secrets.GITHUB_*`; this fix must not regress.
    expect(workflow).not.toContain('vars.GITHUB_CLIENT_ID');
    expect(workflow).not.toContain('secrets.GITHUB_CLIENT_SECRET');
    expect(workflow).not.toMatch(/\$\{\{\s*(?:vars|secrets)\.GITHUB_/);
  });

  it('NEVER binds the real env names to an expression (empty-string = "set" to Zod)', () => {
    // The backend distinguishes "" from absent; a direct `NAME: ${{ secrets.NAME }}`
    // would pass "" when unset. Only the OPT_ aliases and GITHUB_ENV writes may exist.
    expect(workflow).not.toMatch(/\n\s*CREDENTIAL_ENCRYPTION_KEYS:\s*\$\{\{/);
    expect(workflow).not.toMatch(/\n\s*GITHUB_CLIENT_ID:\s*\$\{\{/);
    expect(workflow).not.toMatch(/\n\s*GITHUB_CLIENT_SECRET:\s*\$\{\{/);
  });

  it('forwards the keyring only when present (absent → legacy-only behavior)', () => {
    expect(cfg).toContain('if [ -n "${OPT_CREDENTIAL_ENCRYPTION_KEYS}" ]; then');
    expect(cfg).toContain('CREDENTIAL_ENCRYPTION_KEYS<<__WORKER_ENV_EOF__');
    expect(cfg).toContain('>> "${GITHUB_ENV}"');
  });

  it('enforces GitHub both-or-neither with a non-secret fail-fast, and forwards both only together', () => {
    expect(cfg).toContain('if [ "${id_set}" != "${secret_set}" ]; then');
    expect(cfg).toContain('::error::OAUTH_GH_CLIENT_ID (variable) and OAUTH_GH_CLIENT_SECRET (secret) must be set together');
    expect(cfg).toContain('exit 1');
    expect(cfg).toContain('if [ "${id_set}" = "true" ]; then');
    expect(cfg).toContain('GITHUB_CLIENT_ID<<__WORKER_ENV_EOF__');
    expect(cfg).toContain('GITHUB_CLIENT_SECRET<<__WORKER_ENV_EOF__');
  });

  it('never traces or echoes a secret value to stdout (only into $GITHUB_ENV)', () => {
    expect(workflow).not.toMatch(/^\s*set\s+-x/m);
    expect(workflow).not.toMatch(/echo[^\n]*\$\{\{\s*secrets\./);
    // Every raw-value echo of an OPT_ var must sit inside a `{ … } >> "${GITHUB_ENV}"`
    // group — never a bare stdout echo.
    let inEnvGroup = false;
    for (const raw of cfg.split('\n')) {
      const t = raw.trim();
      if (t === '{') inEnvGroup = true;
      if (/^echo "\$\{OPT_[A-Z_]+\}"$/.test(t)) {
        expect(inEnvGroup, `raw value echo must be redirected to $GITHUB_ENV: ${t}`).toBe(true);
      }
      if (t.startsWith('} >> "${GITHUB_ENV}"')) inEnvGroup = false;
    }
  });
});

