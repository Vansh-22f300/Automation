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
  const [events, runs, jobs] = await Promise.all([
    repository.listEvents(),
    repository.listRuns(),
    repository.listJobs(),
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
    lines.push(
      `  ${j.id}  status=${j.status}  run=${j.runId}  step=${j.stepKey}  attempt=${j.attempt}/${j.maxAttempts}  locked_by=${j.lockedBy ?? '-'}`,
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
