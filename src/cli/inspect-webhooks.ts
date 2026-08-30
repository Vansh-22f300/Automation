/**
 * Inspection helper: list a tenant's recent events and workflow runs.
 *
 * The minimum mechanism the spec asks for to verify — against a real database —
 * that ingestion actually persisted events and (where a workflow was configured)
 * created runs, and that the relationships between them are right. It is a
 * read-only development aid, not a production endpoint.
 *
 *   pnpm webhooks:inspect <tenantId>
 *
 * It prints, for this tenant only (tenant-scoped repository), the most recent
 * events and runs, showing each run's pinned workflow/version and the event it
 * came from — enough to confirm version pinning and event→run linkage by eye.
 */

import { loadEnv } from '@/config/env.js';
import { createDatabase } from '@/db/client.js';
import { createLogger } from '@/observability/logger.js';
import { summarizeValue, toSafeError } from '@/domain/redaction.js';
import { PostgresJobQueue } from '@/repositories/job-queue.js';
import { TenantScope } from '@/repositories/tenant-scope.js';
import { WebhookRepository } from '@/repositories/webhook-repository.js';

const tenantId = process.argv[2];
if (tenantId === undefined || tenantId.trim() === '') {
  process.stderr.write('usage: pnpm webhooks:inspect <tenantId>\n');
  process.exit(1);
}

const env = loadEnv();
const logger = createLogger(env, { service: 'cli' });
const database = createDatabase(env, logger, { service: 'cli' });

try {
  await database.verifyConnection();

  const repository = new WebhookRepository(
    new TenantScope(database.db, tenantId),
    new PostgresJobQueue(database.db),
  );
  const [events, runs, jobs, stepRuns, usage] = await Promise.all([
    repository.listEvents(),
    repository.listRuns(),
    repository.listJobs(),
    repository.listStepRuns(),
    repository.listLlmUsage(),
  ]);

  const lines: string[] = [];
  lines.push(`events (${events.length}), newest first:`);
  for (const e of events) {
    lines.push(
      `  ${e.id}  source=${e.source}  dedupe=${e.dedupeKey.slice(0, 16)}…  received=${e.receivedAt.toISOString()}`,
    );
  }
  lines.push('');
  lines.push(`workflow_runs (${runs.length}), newest first:`);
  for (const r of runs) {
    lines.push(
      `  ${r.id}  status=${r.status}  workflow=${r.workflowId}  version=${r.workflowVersionId}  event=${r.eventId}  step=${r.currentStepKey ?? '-'}`,
    );
  }
  lines.push('');
  lines.push(`jobs (${jobs.length}), newest first:`);
  for (const j of jobs) {
    // `locked_by` is an internal worker id, not operator-facing — collapse it to a
    // liveness boolean rather than printing it. `last_error` is mapped to the safe
    // error shape so no stack or detail can leak through this dev aid.
    const leased = j.status === 'running' && j.lockedBy !== null;
    const lastError = toSafeError(j.lastError);
    const errPart = lastError === null ? '' : `  last_error=${lastError.code}: ${lastError.message}`;
    lines.push(
      `  ${j.id}  status=${j.status}  run=${j.runId}  step=${j.stepKey}  attempt=${j.attempt}/${j.maxAttempts}  leased=${leased}${errPart}`,
    );
  }
  lines.push('');
  lines.push(`workflow_step_runs (${stepRuns.length}), newest first:`);
  for (const s of stepRuns) {
    const duration = s.durationMs === null ? '-' : `${s.durationMs}ms`;
    // Never print raw output/error: summarize the output (size + redacted preview)
    // and map the error to the safe shape.
    let detail: string;
    if (s.status === 'failed') {
      const safe = toSafeError(s.error);
      detail = safe === null ? 'error=-' : `error=${safe.code}: ${safe.message}`;
    } else {
      const summary = summarizeValue(s.output ?? null);
      detail = `output=${summary.preview} (${summary.bytes}b)`;
    }
    lines.push(
      `  ${s.id}  status=${s.status}  run=${s.runId}  step=${s.stepKey}(${s.stepType})  attempt=${s.attempt}  ${duration}  ${detail}`,
    );
  }
  lines.push('');
  lines.push(`llm_usage (${usage.length}), newest first:`);
  for (const u of usage) {
    // Metadata only — never the prompt, the input payload, or the model output.
    lines.push(
      `  ${u.id}  run=${u.runId}  step_run=${u.stepRunId}  ${u.provider}/${u.model}  tokens=${u.inputTokens}in/${u.outputTokens}out/${u.totalTokens}total  ${u.latencyMs}ms`,
    );
  }
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
} catch (error) {
  logger.fatal({ err: error }, 'failed to inspect webhooks');
  process.exitCode = 1;
} finally {
  await database.close();
}
