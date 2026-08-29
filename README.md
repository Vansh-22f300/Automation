# AI Workforce

AI-powered operations automation. Business applications are connected, a process
is described, and the platform executes it — receiving triggers, reasoning with
an LLM, calling external tools, and keeping a durable audit trail of every step.

> **Status: Step 6 of 13 — workflow execution engine (linear `noop` workflows).**
> The project has a PostgreSQL schema, migrations and a connection pool, a Fastify
> API with a health endpoint and tenant API-key authentication, a tenant-scoped
> service for authoring workflows and their immutable versioned definitions, a
> webhook endpoint that captures events idempotently and creates a queued workflow
> run (and its first job) atomically, and a durable `jobs` queue with a worker that
> claims work under a lease (`FOR UPDATE SKIP LOCKED`) and a reaper that returns
> abandoned jobs to the queue. There is still no step executor and no AI
> integration — a job is claimed but nothing executes the step yet; the worker
> records that boundary as a clear job failure rather than pretending work was done.
> See [Current status](#current-status) for exactly what does and does not exist.

---

## Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | **>= 24.0.0, < 25** | Pinned via `engines`. Verified on v24.16.0. |
| pnpm | **>= 10** | Verified on 11.4.0. `npm install -g pnpm` if missing. |
| PostgreSQL | **>= 13** | Required from Step 2 on. Local or hosted — see below. |

PostgreSQL 13 is the floor because the schema relies on `gen_random_uuid()` being
built in. No Docker, no Redis and no API keys are needed yet.

### Getting a database

Any standard PostgreSQL server works; the provider is a deployment decision, not
a code decision. Nothing outside `DATABASE_URL` changes between them.

- **Hosted (easiest, no install)** — create a free project on
  [Neon](https://neon.tech) or [Supabase](https://supabase.com) and copy the
  connection string. Append `?sslmode=require`.
- **Local** — install [PostgreSQL](https://www.postgresql.org/download/), then
  `createdb ai_workforce`.
- **Docker** — `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17`

## Installation

```bash
pnpm install
```

Then create a local config file and set `DATABASE_URL` in it. Unlike Step 1 this
is now mandatory — `DATABASE_URL` has no default and the processes refuse to
start without it:

```bash
cp .env.example .env
```

Apply the schema:

```bash
pnpm db:migrate
```

## Available commands

| Command | What it does |
| --- | --- |
| `pnpm dev:api` | Run the API in watch mode (`tsx`), restarting on file changes. |
| `pnpm dev:worker` | Run the worker in watch mode. |
| `pnpm tenant:create "<name>"` | Create a tenant; prints its id. Bootstrap step before minting a first key. |
| `pnpm apikey:create <tenantId> "<name>"` | Mint an API key for a tenant. Prints the plaintext **once** — it is never retrievable again. |
| `pnpm workflow:create <tenantId> "<name>" [source]` | Author a test workflow (linear `noop` definition, `webhook` trigger) and its active version 1. Prints the ids. |
| `pnpm webhooks:inspect <tenantId>` | List a tenant's recent events, workflow runs and jobs (read-only dev aid to verify ingestion and queueing). |
| `pnpm typecheck` | Type-check the project and the tooling configs, without emitting. |
| `pnpm test` | Run the test suite once (`vitest run`). |
| `pnpm build` | Compile TypeScript to `dist/` and rewrite `@/*` aliases to relative paths. |
| `pnpm start:api` | Run the compiled API from `dist/` (production mode). |
| `pnpm start:worker` | Run the compiled worker from `dist/`. |

### Database commands

| Command | What it does |
| --- | --- |
| `pnpm db:generate` | Diff `src/db/schema.ts` against `drizzle/` and write a new migration. **Needs no database.** |
| `pnpm db:migrate` | Apply pending migrations. Idempotent. |
| `pnpm db:migrate:dist` | Same, from the compiled output — what a deploy runs before starting the API. |
| `pnpm db:check` | Verify the migration files and snapshots are consistent with each other. No database needed. |
| `pnpm db:push` | Sync the schema straight to the database without a migration. **Dev prototyping only.** |
| `pnpm db:studio` | Open Drizzle Studio to browse the data. |

The normal loop when changing the schema:

```bash
pnpm db:generate --name add_workflow_runs
```

Read the generated SQL in `drizzle/`, commit it alongside the schema change, then
`pnpm db:migrate`. Migrations are generated artefacts but they are reviewed and
version-controlled like source: they are what actually runs in production.

`pnpm db:push` skips that trail entirely. It is convenient while iterating on a
throwaway local database and should never touch a shared one.

## Starting the API

```bash
pnpm dev:api
```

It verifies the database is reachable **before** opening the port, then binds to
`HOST:PORT` (default `127.0.0.1:3000`).

### Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/healthz` | none | Liveness + database readiness. `200` healthy, `503` if the DB is unreachable. |
| `POST` | `/v1/api-keys` | Bearer key | Create a key for the caller's tenant. Returns the plaintext **once**. |
| `GET` | `/v1/api-keys` | Bearer key | List the caller's own keys (metadata only — never the key). |
| `POST` | `/v1/api-keys/:id/revoke` | Bearer key | Revoke one of the caller's keys. `204` on success, `404` if it is not theirs. |
| `POST` | `/v1/webhooks/:source` | Bearer key | Ingest a webhook. Captures the event idempotently and, if `:source` has an active workflow, creates a queued run. |

#### Webhook ingestion (`POST /v1/webhooks/:source`)

The event is **always accepted**; only the routing outcome varies. Ingestion is
idempotent: the dedupe key is the caller's `X-Event-ID` header if present, else a
SHA-256 of the raw request body — a retried delivery never creates a second event
or run. The event and (when configured) its run are written in one transaction.

| Outcome | Status | Body |
| --- | --- | --- |
| New event, active workflow matched | `202` | `{ event_id, run_id, status: "queued" }` |
| New event, no workflow for the source | `202` | `{ event_id, run_id: null, status: "accepted", workflow: "not_configured" }` |
| Duplicate delivery | `200` | `{ event_id, run_id, status: "duplicate" }` |

```bash
curl -s -X POST http://127.0.0.1:3000/v1/webhooks/github \
  -H "Authorization: Bearer awk_your_key_here" \
  -H "Content-Type: application/json" \
  -H "X-Event-ID: delivery-123" \
  -d '{"action":"opened"}'
```

Routing is DB-enforced: **one tenant + one webhook source = one active workflow**,
via a partial unique index on `(tenant_id, trigger_config->>'source') WHERE
is_active`. A created run pins the exact `workflow_version_id` at creation, so
activating a newer version never changes runs already in flight.

> **HMAC signature verification is not implemented yet.** A bearer key is the only
> authentication. The raw request body is preserved (`request.rawBody`) precisely
> so per-provider signature verification can be added at this boundary without a
> rewrite. **Provider webhooks must not be enabled in production before that
> lands.**

Authentication is a bearer API key:

```bash
curl -s http://127.0.0.1:3000/healthz

# Everything under /v1 requires a key:
curl -s http://127.0.0.1:3000/v1/api-keys \
  -H "Authorization: Bearer awk_your_key_here"
```

Keys are cryptographically random. Only a SHA-256 hash and a short lookup prefix
are stored — the full key is shown exactly once, at creation, and is never
retrievable or logged afterwards. Every failure to authenticate (missing,
malformed, unknown, wrong or revoked key) returns the same `401` so a caller
cannot tell them apart. There is no way to authenticate to create your *first*
key, so the first one per tenant is minted out-of-band:

```bash
TENANT_ID=$(pnpm -s tenant:create "Acme Inc")
pnpm apikey:create "$TENANT_ID" "bootstrap"   # prints the plaintext once
```

A conservative in-memory rate limit (100 requests/minute per IP) blunts
credential stuffing on a single instance. It is per-process and resets on
restart; distributed, per-tenant rate limiting with a shared store arrives later.

Stop the server with `Ctrl+C`; it drains in-flight requests, closes the pool, and
logs `api stopped cleanly`.

## Starting the worker

```bash
pnpm dev:worker
```

It verifies the database, logs `worker_started`, then runs two long-lived loops
against the `jobs` table:

- a **claim loop** that takes one ready job at a time with `SELECT … FOR UPDATE
  SKIP LOCKED` inside a short transaction, stamps this worker's instance id and a
  five-minute lease on it, checks the job's run still exists, and hands it to a
  dispatcher — logging `job_claimed`, then `job_completed` or `job_failed`;
- a **reaper** that periodically returns jobs whose lease has expired to `pending`
  (incrementing `attempt`), so a job held by a crashed worker is never lost —
  logging `job_requeued` when it recovers any.

Two workers can run at once without ever claiming the same job; that guarantee is
PostgreSQL's, via `FOR UPDATE SKIP LOCKED`, not the application's.

> **The worker now executes steps.** The dispatcher is the real
> [`WorkflowExecutor`](src/repositories/execution-engine.ts): each claimed job
> advances its run by **exactly one step**. In one transaction it records a
> `workflow_step_runs` row, updates the run's context and status, and either
> enqueues the single next step's job or finishes the run — atomically. A step
> failure marks the step run and the run `failed`, enqueues nothing, and fails the
> queue job (no retries yet — that is Step 11). A redelivered job for a run that
> has already advanced (or finished) does no work. The engine runs the version the
> run pinned at creation, never the currently-active one, and scopes every
> statement to the job's tenant. Only the `noop` step type is registered so far.
> A job whose run has vanished fails as `run_not_found`; an unexpected error leaves
> the job `running` so the reaper recovers it.

Stop it with `Ctrl+C`; it stops claiming first, drains the loops, closes the pool,
and logs `worker_shutdown`.

The two processes are independent — neither requires the other to run. Both
refuse to start if the database is unreachable, because a process that is
listening but cannot reach its database looks healthy to whatever is watching it.

## Configuration

Environment variables are validated at startup by
[`src/config/env.ts`](src/config/env.ts) using Zod. If anything is invalid the
process prints the offending variables and **exits with code 1** rather than
starting in a half-configured state:

```
FATAL: configuration error — refusing to start.

  DATABASE_URL: must be set to a PostgreSQL connection string

  See .env.example for the expected values.
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | **required** | PostgreSQL connection URL. Add `?sslmode=require` for hosted providers. |
| `DATABASE_POOL_MAX` | `10` | Max pooled connections **per process**. Two processes run, so the real ceiling is roughly double. |
| `NODE_ENV` | `development` | `development` enables pretty logs; `production` emits JSON. |
| `LOG_LEVEL` | `info` | pino level: `fatal`…`trace`, or `silent`. `debug` also logs every SQL statement. |
| `HOST` | `127.0.0.1` | API bind address. Use `0.0.0.0` in a container or on a PaaS. |
| `PORT` | `3000` | API port. |

`.env` is loaded by Node's built-in `--env-file-if-exists`, so no `dotenv`
dependency is involved. Validation of `DATABASE_URL` is structural only — scheme,
host and database name — and never echoes the URL in an error, because it carries
a password and these messages go to stderr.

Variables are added only when code actually consumes them. `ANTHROPIC_API_KEY`
and the credential encryption key arrive with the steps that need them.

## Project layout

```
src/
├── api/
│   ├── server.ts             Entrypoint 1 — process wiring: pool, auth, listen
│   ├── app.ts                Framework composition root — buildApp(deps), no listen
│   ├── types.ts              The shared Fastify instance type alias
│   ├── errors.ts             HTTP error taxonomy + one error envelope
│   ├── error-handler.ts      Central error/not-found handler
│   ├── auth-hook.ts          HTTP → AuthContext adapter (onRequest)
│   └── routes/               health.ts, api-keys.ts, webhooks.ts
├── auth/
│   ├── context.ts            Framework-free Authenticator seam + AuthContext
│   ├── api-key.ts            Key generation, hashing, parsing, verification
│   ├── api-key-store.ts      The one unscoped lookup (auth-only)
│   └── api-key-authenticator.ts   Resolves a key to a tenant, or 401
├── repositories/
│   ├── tenant-scope.ts       TenantScope + TenantScopedRepository base
│   ├── api-key-repository.ts Tenant-scoped create/list/revoke
│   ├── workflow-repository.ts  Tenant-scoped workflow + immutable version authoring
│   ├── webhook-repository.ts   Tenant-scoped webhook ingestion (event + run + first job, one txn)
│   ├── job-queue.ts            PostgresJobQueue — enqueue/claim/complete/fail/requeueExpired
│   └── execution-engine.ts     WorkflowExecutor — advances a run by one step, atomically
├── cli/                      create-tenant.ts, create-api-key.ts, create-workflow.ts, inspect-webhooks.ts (bootstrap/dev)
├── worker/
│   ├── main.ts               Entrypoint 2 — composition root: worker + reaper wiring, shutdown
│   ├── worker.ts             The claim → verify → dispatch → settle loop
│   ├── reaper.ts             Periodic sweep returning expired-lease jobs to the queue
│   └── dispatcher.ts         StepDispatcher seam + StepFailedError (WorkflowExecutor implements it)
├── db/
│   ├── schema.ts             Tables, enums, constraints — source of truth
│   ├── client.ts             Pool + typed Drizzle instance + clean shutdown
│   └── migrate.ts            Migration runner (also runs from dist/)
├── config/env.ts             Zod-validated, fail-fast environment config
├── observability/logger.ts   pino structured logging + correlation-ID helper
├── domain/
│   ├── ids.ts                UUIDv7 id generator
│   ├── errors.ts             RetryableError / PermanentError taxonomy
│   ├── workflow-definition.ts  Zod schema for linear noop workflow definitions
│   ├── workflow-trigger.ts   Zod schema for webhook trigger config
│   ├── workflow-run.ts       Run-context builder (trigger facts + empty steps)
│   ├── run-state.ts          Run-status state machine (queued→running→succeeded/failed)
│   ├── execution-context.ts  Framework-free trigger + step-output accessor
│   ├── references.ts         No-eval {{trigger.*}} / {{steps.*.output}} resolver
│   ├── step-handler.ts       StepHandler interface + registry (noop)
│   └── queue.ts             Framework-free Queue contract + InvalidJobTransitionError
└── test/
    ├── unit/                 No external dependencies
    └── integration/          Requires PostgreSQL; skipped without it
drizzle/                      Generated SQL migrations + snapshots (committed)
drizzle.config.ts             drizzle-kit config (tooling, not application code)
```

One codebase, two deployable processes. They share all domain code by direct
import, and are separate processes because they fail and scale differently — a
slow LLM call must never block webhook ingestion.

Directories for future concerns (`engine/`, `queue/`, `llm/`, `connectors/`,
`security/`) are deliberately **not** created yet; they appear when they hold real
code rather than placeholder files.

### Conventions worth knowing

- **ESM throughout.** Relative and aliased imports carry an explicit `.js`
  extension, as Node's ESM resolver requires.
- **`@/*` maps to `src/*`.** `tsx` and Vitest resolve it directly; `tsc-alias`
  rewrites it to relative paths during `pnpm build`.
- **Strict TypeScript**, including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`.
- **Config is passed, not imported as a global.** `loadEnv()` is called once per
  entrypoint and the result handed to whatever needs it, so domain and engine
  code stays pure and testable.
- **The database handle is passed too.** `createDatabase()` returns a handle its
  creator owns and closes; there is no exported `db` singleton, so importing a
  module can never open a socket as a side effect.
- **Errors are classified where they are raised** as either `RetryableError` or
  `PermanentError`. Unclassified errors are treated as *not* retryable.
- **Credentials never reach a log.** Connection URLs are reduced to
  host/port/database before being logged, and SQL is logged without its
  parameters.

## Data model

Eight tables so far. Two rules drive the shape of all of them.

**Every tenant-scoped table carries `tenant_id`** — even where it is derivable by
joining. Tenant isolation has to be expressible as a predicate on the table being
read; a query that must join to discover which tenant a row belongs to is a query
that can leak.

**Workflow definitions are data, not tables and not code.** A definition is one
`jsonb` document. Users will eventually author workflows in natural language, so
the step graph must be something the platform can produce, version and interpret
at runtime — not a schema migration. Shredding steps into relational tables would
buy referential integrity we do not need and cost the ability to treat a
definition as a single immutable versioned value.

| Table | Holds | Notes |
| --- | --- | --- |
| `tenants` | One row per customer organisation | Root of every ownership chain. `suspended` stops execution without deleting history. |
| `users` | A human, belonging to one tenant | No auth material yet. Unique per tenant on `lower(email)`. |
| `workflows` | The stable identity of a process | Name, status. Holds no logic itself. |
| `workflow_versions` | An immutable snapshot of the logic | `definition` jsonb, trigger config, version number. |
| `events` | A raw external signal captured at the webhook boundary | `source`, `dedupe_key`, `payload` jsonb, `received_at`. Idempotent per `(tenant_id, source, dedupe_key)`. |
| `workflow_runs` | One execution of a workflow, born from an event | Pins `workflow_id` + `workflow_version_id` + `event_id`; `status` (starts `queued`), `context` jsonb. A worker claims its jobs, but no step executes yet. |
| `jobs` | A unit of durable work advancing a run's step | `step_key`, `attempt`/`max_attempts`, `status` (`pending`→`running`→`done`/`failed`), `run_at`, `locked_by` + `lease_expires_at` (the lease), `last_error`. Claimed with `FOR UPDATE SKIP LOCKED`. |
| `api_keys` | A tenant's bearer credentials | Stores a SHA-256 `key_hash` and a short `prefix`, never the key. `revoked_at` disables one. |

Two constraints are worth calling out because they encode invariants the
application would otherwise have to remember:

- **`workflow_versions` has no `updated_at`.** Versions are never updated, only
  inserted. A run pins the exact version it started under, so an in-flight
  execution cannot have the ground shift beneath it and a run that failed months
  ago can still be explained. The absent column is the documentation.
- **At most one active version per workflow**, enforced by a partial unique index
  on `(workflow_id) WHERE is_active`. The obvious alternative —
  `workflows.active_version_id` — creates a circular foreign key between the two
  tables; putting the flag on the version removes the cycle and lets the database
  enforce the real rule.

A version also cannot be attached to a workflow in a different tenant: the
foreign key is composite, `(tenant_id, workflow_id) → workflows(tenant_id, id)`.
Cross-tenant corruption is the most damaging bug class in a multi-tenant system
and the hardest to notice, so it is made unrepresentable rather than merely
avoided. `events` and `workflow_runs` follow the same rule: a run's three foreign
keys are all composite `(tenant_id, X) → parent(tenant_id, id)`, so a run cannot
reference a workflow, version or event from another tenant. Ingestion idempotency
is the database's job too — a `UNIQUE(tenant_id, source, dedupe_key)` on `events`,
combined with `INSERT … ON CONFLICT DO NOTHING`, not an application check-then-insert
(which races). Routing is enforced by a second partial unique index on
`(tenant_id, trigger_config->>'source') WHERE is_active`: at most one active
workflow per tenant per source, so a delivery resolves to exactly one version.

`jobs` extends the same discipline to the queue. Its foreign key is composite,
`(tenant_id, run_id) → workflow_runs(tenant_id, id)` (which is why `workflow_runs`
carries an explicit `UNIQUE(tenant_id, id)`), so a job can never be attached to a
run in another tenant. Two partial indexes keep the hot paths tight: one on
`(run_at) WHERE status = 'pending'` for the claim scan, and one on
`(lease_expires_at) WHERE status = 'running'` for the reaper sweep — neither ever
scans settled work. The first job of a run is created inside the *same*
transaction as the event and the run, so there is never a queued run without a job
to advance it.

### Authentication and tenant isolation

Tenant isolation is enforced in the application layer by a `TenantScope`: a small
value that binds a database handle to exactly one tenant id. Repositories are
constructed *from* a scope, never from a bare handle, so an instance is
intrinsically pinned to one tenant and its queries cannot omit the tenant
predicate. There are no generic "fetch across all tenants" helpers.

The one unavoidable exception — resolving *which* tenant a presented API key
belongs to, before any tenant is known — is confined to a single narrow
`ApiKeyStore` used only by the authenticator, and named to make its exceptional
nature obvious. PostgreSQL Row-Level Security will later back this with a
database-enforced guarantee; until then this pattern is the boundary, and it is
proven end-to-end by the tenant-isolation tests. The authentication mechanism
itself sits behind a framework-free `Authenticator` seam that yields
`request.auth.tenantId`, so it can be swapped for sessions, OAuth or RBAC later
without touching route code.

## Testing

```bash
pnpm test
```

Unit tests need nothing external. They cover configuration validation, the error
taxonomy, connection-pool wiring and credential redaction, the API-key
cryptography, the authenticator's failure modes, and the whole HTTP boundary
(driven by `app.inject` with in-memory fakes: health up/down, every 401 path, the
key lifecycle, route-level tenant isolation, and the plaintext never being logged
or listed). They also assert the schema's structural invariants directly against
the Drizzle model — a dropped `tenant_id`, a naive `timestamp`, or an
`updated_at` appearing on `workflow_versions` all fail the build. For workflow
authoring they cover definition validation (valid `noop` accepted; empty steps,
duplicate keys, bad key format, unknown step type, malformed config all rejected)
and trigger-config validation. The worker loop is covered with an in-memory fake
queue: an unimplemented step is failed and **never completed**, a job whose run
has vanished is failed without dispatch, a job is completed only when the
dispatcher reports success, an unexpected dispatcher error leaves the job
untouched for the reaper, and a stopped worker claims nothing further.

Integration tests require a real PostgreSQL server and are **skipped** without
one. They are never simulated: no database means skipped, not passed.

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_workforce_test pnpm test
```

They apply the migration and then exercise what only a real server can prove: the
partial unique index, the composite foreign key, case-insensitive email
uniqueness, jsonb round-tripping, cascade deletes, and — for `api_keys` — that
the plaintext is absent from every column, that a real key round-trips through
the authenticator, and that SQL-level tenant scoping stops one tenant reading or
revoking another's keys. For workflows they prove version 2 is a fresh INSERT that
leaves version 1 unchanged, that the unique version constraint refuses a duplicate,
that promoting a version keeps exactly one active, and that one tenant cannot read,
version or activate another's workflow. For the **job queue** they prove what
mocking cannot: that `claim` moves exactly one pending row to `running` under a
lease (oldest first, never a future `run_at`), that two workers claiming
concurrently never receive the same job and each gets a distinct one when several
are ready (the `SKIP LOCKED` guarantee), that `complete`/`fail` reject illegal
transitions and a terminal job is never re-claimed, that the reaper requeues an
expired-lease job and increments its attempt while leaving live leases alone, and
that a tenant-scoped queue can neither claim nor mutate another tenant's jobs.
Because they write and delete rows, they refuse to run unless the database name
contains `test`.

## Current status

### Implemented (Steps 1–6)

- pnpm + ESM + strict TypeScript project setup, Node 24 pinned
- Fail-fast, Zod-validated environment configuration
- Structured pino logging with a `withContext` helper for `tenant_id`,
  `run_id`, `step_run_id`
- `RetryableError` / `PermanentError` taxonomy
- PostgreSQL schema for `tenants`, `users`, `workflows`, `workflow_versions`,
  `events`, `workflow_runs`, `workflow_step_runs`, `jobs`, `api_keys`, with
  time-ordered UUIDv7 primary keys generated application-side
- Drizzle ORM setup, connection pool with clean shutdown, and a migration
  workflow that needs no database to generate or verify
- Database connectivity verified at startup before the API opens its port
- **Fastify API** with clean shutdown on `SIGTERM`/`SIGINT`:
  - `GET /healthz` — liveness + database readiness (`select 1`), leaking no
    connection detail
  - **Tenant API-key authentication** — cryptographically random keys, SHA-256
    hash + short prefix stored (never the plaintext), constant-time verification,
    revocation, and a framework-free `Authenticator` seam yielding
    `request.auth.tenantId`
  - **Tenant isolation** via `TenantScope`, with the single unscoped auth lookup
    quarantined; tests prove one tenant cannot read or revoke another's keys
  - Minimal key-management endpoints (`/v1/api-keys`), key returned once
  - One consistent error envelope (`401/403/404/400/429/500`) with a request id
    correlated into the logs, never exposing internals
  - Conservative in-memory rate limiting (no Redis)
- **Workflow authoring (Step 4A)** — a Zod-validated workflow definition
  (linear `noop` steps: unique valid keys, at least one step, no unknown step
  types or config) and a `webhook` trigger config, both framework-free and
  reusable; a tenant-scoped `WorkflowRepository` that creates a workflow with its
  active version 1, appends immutable new versions (fresh INSERT, version 1 never
  updated), numbers versions monotonically with a `FOR UPDATE` lock plus the DB
  unique constraint as backstop, and promotes a version inside one transaction so
  "at most one active" always holds
- **Webhook ingestion (Step 4B)** — `POST /v1/webhooks/:source` under the existing
  tenant API-key auth: the raw body is preserved for future HMAC, the dedupe key is
  `X-Event-ID` or a SHA-256 of the body, and the event plus (when a source has an
  active workflow) its `queued` run are written in one transaction via `INSERT …
  ON CONFLICT DO NOTHING`. Idempotency and "one active workflow per (tenant,
  source)" are both DB-enforced; a run pins its exact version at creation. No
  workflow for a source is a success (event kept, no run), not an error. A
  `webhooks:inspect` CLI lists a tenant's events, runs and jobs.
- **Job queue, worker and reaper (Step 5)** — a durable `jobs` table and a
  framework-free `Queue` contract (`enqueue`/`claim`/`complete`/`fail`/
  `requeueExpired`) with a PostgreSQL implementation that claims one ready job at a
  time via `SELECT … FOR UPDATE SKIP LOCKED` in a short transaction, holds it under
  a five-minute lease (`locked_by` + `lease_expires_at`), and rejects illegal state
  transitions (`done`/`failed` are terminal). The worker stamps its instance id on
  every claim, verifies the run still exists, dispatches, and settles — with
  structured logs (`worker_started`, `job_claimed`, `job_completed`, `job_failed`,
  `job_requeued`, `worker_shutdown`) carrying `tenant_id`/`run_id`/`job_id`/
  `worker_id`. A reaper returns expired-lease jobs to `pending` (incrementing
  `attempt`) with a single atomic UPDATE, safe across processes. The first job is
  created in the same transaction as the event and run. **No step executes yet**:
  the dispatcher refuses every step and the worker records that as a terminal
  failure, never marking a job `done`.
- **Workflow execution engine (Step 6)** — the real `StepDispatcher`
  ([`WorkflowExecutor`](src/repositories/execution-engine.ts)): one claimed job
  advances its run by **exactly one step**, never loading or running a whole
  workflow. Everything for that step commits in a single transaction — a
  `workflow_step_runs` audit row (`running` → `succeeded`/`failed`, with
  `input`/`output`/`error` and `duration_ms`), the run's grown `context` and
  status, and either the next step's job or the run's completion — so there is
  never "step recorded but next job missing" nor the reverse. A framework-free
  `ExecutionContext` and a no-`eval` reference resolver (`{{trigger.payload.x}}`,
  `{{steps.first.output}}` — unknown paths fail cleanly, nothing is evaluated)
  feed each step its input; a `StepHandler` registry keeps step internals out of
  the worker (only `noop`, yielding `{ ok: true }`, is registered). Idempotency
  under at-least-once delivery is two-layered: a `SELECT … FOR UPDATE` on the run
  plus a "has this run already advanced past this step?" guard, backed by a
  partial unique index (one success per `run_id`+`step_key`+`attempt`). The run
  executes its **pinned** `workflow_version_id`, never the currently-active one;
  every statement is tenant-scoped. A failure marks the step run and run `failed`
  and enqueues nothing (no retries — Step 11). `webhooks:inspect` now also lists
  step runs. Structured logs: `step_started`, `step_succeeded`, `step_failed`,
  `run_advanced`, `run_succeeded`, `run_failed`.
- Bootstrap CLIs for creating a tenant and its first key
- Build pipeline producing runnable output in `dist/`

### Not implemented yet — intentionally

Nothing below exists in any form. It is sequenced, not forgotten.

| Area | Arrives in |
| --- | --- |
| Claude integration behind an `LlmProvider` interface | Steps 7–8 |
| Connectors, credential encryption, first integration (Slack) | Steps 9–10 |
| Retry policy and backoff | Step 11 |
| Run inspection endpoints and log redaction | Step 12 |
| Distributed rate limiting, PostgreSQL RLS, CI | Step 13 |
| HMAC / provider signature verification on webhooks | before production webhooks |

The tables later steps need — `connections`, `audit_log` — are not
in the schema yet, for the same reason the directories are empty: they arrive with
the code that uses them.

Explicitly out of scope for the MVP entirely: OAuth flows, billing, a visual
workflow builder, Redis/Kafka, Kubernetes, microservices, vector stores or agent
memory, and any model training or fine-tuning.
