/**
 * Inspection helper: show one workflow run, tenant-scoped and safe by default.
 *
 *   pnpm runs:inspect <tenantId> <runId> [--detail]
 *
 * A read-only development/operations aid — not a production endpoint. It builds a
 * tenant-scoped `RunInspectionRepository` (so it can only ever see runs of the
 * given tenant) and prints the same `RunInspection` view the HTTP endpoint
 * returns. Values are summarized (size + redacted preview) by default; `--detail`
 * additionally prints the secret-scrubbed raw context/payload/input/output.
 *
 * A run that does not exist for the tenant — absent or another tenant's — prints
 * "not found" and exits non-zero, exactly the ambiguity the API's 404 preserves.
 */

import { loadEnv } from '@/config/env.js';
import { createDatabase } from '@/db/client.js';
import { createLogger } from '@/observability/logger.js';
import type { RunInspection } from '@/domain/run-inspection.js';
import { RunInspectionRepository } from '@/repositories/run-inspection-repository.js';
import { TenantScope } from '@/repositories/tenant-scope.js';

const args = process.argv.slice(2);
const detail = args.includes('--detail');
const positional = args.filter((a) => !a.startsWith('--'));
const tenantId = positional[0];
const runId = positional[1];

if (tenantId === undefined || tenantId.trim() === '' || runId === undefined || runId.trim() === '') {
  process.stderr.write('usage: pnpm runs:inspect <tenantId> <runId> [--detail]\n');
  process.exit(1);
}

const env = loadEnv();
const logger = createLogger(env, { service: 'cli' });
const database = createDatabase(env, logger, { service: 'cli' });

function render(view: RunInspection): string {
  const lines: string[] = [];
  const r = view.run;
  lines.push(`run ${r.id}  status=${r.status}  step=${r.currentStepKey ?? '-'}`);
  lines.push(`  workflow=${view.workflow.name} (${view.workflow.id}) status=${view.workflow.status}`);
  lines.push(`  version=v${view.version.version} (${view.version.id}) trigger=${view.version.triggerType}`);
  lines.push(`  created=${r.createdAt}  started=${r.startedAt ?? '-'}  finished=${r.finishedAt ?? '-'}`);
  if (r.error !== null) {
    lines.push(`  error=${r.error.code}: ${r.error.message}${r.error.retryable !== undefined ? ` retryable=${r.error.retryable}` : ''}`);
  }
  lines.push(`  context: ${r.contextSummary.bytes} bytes${r.contextSummary.truncated ? ' (truncated)' : ''}`);
  lines.push(`    preview=${r.contextSummary.preview}`);
  if (detail) lines.push(`    raw=${JSON.stringify(r.context)}`);

  lines.push('');
  const e = view.event;
  lines.push(`event ${e.id}  source=${e.source}  received=${e.receivedAt}`);
  lines.push(`  payload: ${e.payloadSummary.bytes} bytes${e.payloadSummary.truncated ? ' (truncated)' : ''}`);
  lines.push(`    preview=${e.payloadSummary.preview}`);
  if (detail) lines.push(`    raw=${JSON.stringify(e.payload)}`);

  lines.push('');
  lines.push(`steps (${view.steps.length}), execution order:`);
  for (const s of view.steps) {
    const dur = s.durationMs === null ? '-' : `${s.durationMs}ms`;
    lines.push(`  ${s.stepKey}(${s.stepType})  status=${s.status}  attempt=${s.attempt}  ${dur}`);
    if (s.error !== null) lines.push(`    error=${s.error.code}: ${s.error.message}`);
    lines.push(`    input: ${s.inputSummary.bytes}b  output: ${s.outputSummary.bytes}b`);
    lines.push(`    output.preview=${s.outputSummary.preview}`);
    if (detail) {
      lines.push(`    input.raw=${JSON.stringify(s.input)}`);
      lines.push(`    output.raw=${JSON.stringify(s.output)}`);
    }
  }

  lines.push('');
  lines.push(`jobs (${view.jobs.length}), oldest first:`);
  for (const j of view.jobs) {
    lines.push(
      `  ${j.id}  status=${j.status}  step=${j.stepKey}  attempt=${j.attempt}  retry=${j.retryCount}/${j.maxAttempts}  leased=${j.leased}  run_at=${j.runAt}`,
    );
    if (j.lastError !== null) lines.push(`    last_error=${j.lastError.code}: ${j.lastError.message}`);
  }

  lines.push('');
  lines.push(`llm usage (${view.llmUsage.length} round(s)):`);
  for (const u of view.llmUsage) {
    lines.push(
      `  step=${u.stepKey ?? '-'}  round=${u.round}  ${u.provider}/${u.model}  tokens=${u.inputTokens}in/${u.outputTokens}out/${u.totalTokens}total  ${u.latencyMs}ms`,
    );
  }
  if (view.tools.length > 0) {
    lines.push('');
    lines.push('tool activity (reconstructed from round counts):');
    for (const t of view.tools) {
      lines.push(`  step=${t.stepKey}  rounds=${t.rounds}  used_tools=${t.usedTools}  tool_rounds=${t.toolRounds}`);
    }
  }
  // External-effect ledger, detail mode only. `view.toolEffects` is present iff the
  // run was fetched with --detail. An `ambiguous` effect is the reason this section
  // exists — an external call whose outcome is unknown after a crash — so it is
  // marked with a leading `!! AMBIGUOUS` an operator cannot miss when scanning.
  if (view.toolEffects !== undefined) {
    lines.push('');
    lines.push(`external effects (${view.toolEffects.length}), execution order:`);
    const ambiguousCount = view.toolEffects.filter((x) => x.ambiguous).length;
    if (ambiguousCount > 0) {
      lines.push(`  !! ${ambiguousCount} AMBIGUOUS effect(s) — outcome unknown, not auto-resent; reconcile manually`);
    }
    for (const x of view.toolEffects) {
      const marker = x.ambiguous ? '!! AMBIGUOUS ' : '';
      lines.push(
        `  ${marker}step=${x.stepKey}  tool=${x.toolName}  #${x.ordinal}  ${x.provider}  state=${x.state}`,
      );
      if (x.error !== null) lines.push(`    error=${x.error.code}: ${x.error.message}`);
    }
  }
  const tot = view.usageTotals;
  lines.push('');
  lines.push(
    `totals: rounds=${tot.rounds}  tokens=${tot.inputTokens}in/${tot.outputTokens}out/${tot.totalTokens}total  ${tot.latencyMs}ms`,
  );
  return lines.join('\n') + '\n';
}

try {
  await database.verifyConnection();

  const repository = new RunInspectionRepository(new TenantScope(database.db, tenantId));
  const view = await repository.getRun(runId, { detail });
  if (view === null) {
    process.stderr.write(`run not found for tenant ${tenantId}: ${runId}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(render(view));
  }
} catch (error) {
  logger.fatal({ err: error }, 'failed to inspect run');
  process.exitCode = 1;
} finally {
  await database.close();
}
