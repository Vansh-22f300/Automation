# AI Workforce — Project Guide for Claude

Multi-tenant workflow automation platform, built in a **fixed 13-step order**. Each
step is scoped, verified, then paused for user review. Read this before exploring —
it captures what would otherwise cost many file reads to re-derive.

## Golden rules (binding, from the user)
- **No git operations** unless explicitly asked in that message — no commit, push,
  branch, PR, or merge. The user drives all git.
- **Do not auto-advance** to the next build step. Implement only the current step's
  scope, then report and STOP.
- **Respect the active scope**: backend hardening is paused after Step 13 Items 1–3.
  The active work is Frontend Milestone 1 only; do not resume Step 13 or add later
  frontend-product scope without a new prompt.
- **Be token-frugal.** Prefer the file-map below and memory over broad searches.

## Stack & commands
Node 24 · pnpm 11 · strict ESM TypeScript · Drizzle ORM + node-postgres · PostgreSQL 13+ · Fastify · pino · vitest · Zod.

The separate `frontend/` package is a Nuxt 3 SPA. Start it with `cd frontend && pnpm dev`.
It talks to Fastify through the Vite development proxy at `/backend`, using
`NUXT_PUBLIC_API_KEY` from the uncommitted `frontend/.env`; no Fastify CORS change
or Nuxt server API is present.

```bash
pnpm typecheck   # tsc --noEmit + tools tsconfig
pnpm test        # vitest run (integration tests skip without TEST_DATABASE_URL)
pnpm build       # tsc -p tsconfig.build.json && tsc-alias
pnpm db:generate # diff schema.ts → new migration in drizzle/ (NO database needed)
pnpm db:check    # verify migrations are consistent
```
**Verification pipeline after any schema/code change:** `db:generate` (if schema changed) → `db:check` → `typecheck` → `test` → `build`. Never `db:push` to author migrations. See the `verify` skill.

Integration tests run only with `TEST_DATABASE_URL` pointed at a DB whose name contains `test`; otherwise they SKIP (never faked). No local PG here, so real-txn/SKIP-LOCKED semantics of new integration tests are written but unproven until run against Postgres.

## Conventions
- **ESM imports carry `.js`** extensions; `@/*` → `src/*`.
- **Primary keys are UUIDv7**, generated app-side via `primaryId()` = `uuid('id').primaryKey().$defaultFn(newId)` (`newId()` from `domain/ids.ts`). Never UUIDv4, never DB-side.
- **Tenant isolation** via `TenantScope` + `TenantScopedRepository`; every statement carries a `tenant_id` predicate. Composite tenant-safe FKs `(tenant_id, X) → parent(tenant_id, id)` require an explicit `unique(tenant_id, id)` on the parent.
- **"One active version"** uses `is_active` + a partial unique index — never a `workflows.active_version_id` column.
- **Framework-free seams**: domain logic (queue, execution, references, handlers) is pure and testable; repositories own persistence; the worker orchestrates.
- Errors: `AppError → RetryableError | PermanentError`; `PermanentError` for deterministic failures; `isAppError()` to classify.
- Logging: `withContext(logger, { tenant_id, run_id, ... }).child({...})`; never log secrets.
- Migrations in `drizzle/` are committed; versions are immutable (new INSERT, never edit an old one).

## File map
```
src/
  api/           server.ts (entry), app.ts (buildApp), routes/{health,api-keys,webhooks}
  auth/          Authenticator seam, api-key gen/hash/verify, unscoped store (auth-only)
  repositories/  tenant-scope, api-key-, workflow-, webhook-repository, job-queue, execution-engine
  worker/        main.ts (entry), worker.ts (claim→verify→dispatch→settle), reaper.ts, dispatcher.ts
  domain/        ids, errors, workflow-definition, workflow-trigger, workflow-run,
                 run-state, execution-context, references, step-handler, queue
  db/            schema.ts (source of truth), client.ts (pool+Drizzle), migrate.ts
  cli/           create-tenant, create-api-key, create-workflow, inspect-webhooks
  test/          unit/ (no deps), integration/ (needs PG, skipped without it)
```

frontend/
  pages/         Nuxt file-based dashboard, collections, and run inspection views
  components/    app shell, UI states, badges, and run lookup
  lib/           typed Fastify API client and display formatting
  composables/   API-client and resource-loading helpers

## Build-order status
Backend Steps 1–12 and Step 13 Items 1–3 are implemented. Frontend Milestone 1 is
the active scope. Do not start Step 13 Item 4 or Frontend Prompt 2 without an
explicit user prompt.

## What each layer owns
- **Queue** (`job-queue.ts`): enqueue/claim/complete/fail/retry/release/requeueExpired; `FOR UPDATE SKIP LOCKED`; 15-min lease derived in `domain/timing.ts` from the real step timeouts. Every settlement is guarded on `locked_by`, so a superseded worker cannot touch a re-claimed row.
- **Worker** (`worker.ts`): claims a job, verifies its run exists, dispatches, settles the queue job by outcome. Shutdown is bounded by `WORKER_SHUTDOWN_TIMEOUT_MS` and hands back the lease of anything still in flight. Knows nothing of workflow internals.
- **Execution engine** (`execution-engine.ts`): one job advances one run by exactly one step, in one transaction (step_run + context/status + next job OR finish). Idempotent (FOR UPDATE + currentStepKey guard + partial unique index), version-pinned, tenant-scoped.
