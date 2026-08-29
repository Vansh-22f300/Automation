# AI Workforce

AI-powered operations automation. Business applications are connected, a process
is described, and the platform executes it — receiving triggers, reasoning with
an LLM, calling external tools, and keeping a durable audit trail of every step.

> **Status: Step 3 of 13 — API skeleton + authentication.**
> The project has a PostgreSQL schema, migrations and a connection pool, plus a
> Fastify API with a health endpoint and tenant API-key authentication. There is
> still no webhook ingestion, no queue, no workflow engine and no AI integration.
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

It verifies the database, logs `worker started`, then emits a `worker tick`
heartbeat roughly once per second. This is a placeholder for the real job-claim
loop (Step 5). Stop it with `Ctrl+C`; it logs `worker stopped cleanly`.

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
│   └── routes/               health.ts, api-keys.ts
├── auth/
│   ├── context.ts            Framework-free Authenticator seam + AuthContext
│   ├── api-key.ts            Key generation, hashing, parsing, verification
│   ├── api-key-store.ts      The one unscoped lookup (auth-only)
│   └── api-key-authenticator.ts   Resolves a key to a tenant, or 401
├── repositories/
│   ├── tenant-scope.ts       TenantScope + TenantScopedRepository base
│   └── api-key-repository.ts Tenant-scoped create/list/revoke
├── cli/                      create-tenant.ts, create-api-key.ts (bootstrap)
├── worker/main.ts            Entrypoint 2 — background worker loop
├── db/
│   ├── schema.ts             Tables, enums, constraints — source of truth
│   ├── client.ts             Pool + typed Drizzle instance + clean shutdown
│   └── migrate.ts            Migration runner (also runs from dist/)
├── config/env.ts             Zod-validated, fail-fast environment config
├── observability/logger.ts   pino structured logging + correlation-ID helper
├── domain/
│   ├── ids.ts                UUIDv7 id generator
│   └── errors.ts             RetryableError / PermanentError taxonomy
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

Five tables so far. Two rules drive the shape of all of them.

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
avoided.

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
`updated_at` appearing on `workflow_versions` all fail the build.

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
revoking another's keys. Because they write and delete rows, they refuse to run
unless the database name contains `test`.

## Current status

### Implemented (Steps 1–3)

- pnpm + ESM + strict TypeScript project setup, Node 24 pinned
- Fail-fast, Zod-validated environment configuration
- Structured pino logging with a `withContext` helper for `tenant_id`,
  `run_id`, `step_run_id`
- Worker process with a heartbeat loop and clean shutdown
- `RetryableError` / `PermanentError` taxonomy
- PostgreSQL schema for `tenants`, `users`, `workflows`, `workflow_versions`,
  `api_keys`, with time-ordered UUIDv7 primary keys generated application-side
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
- Bootstrap CLIs for creating a tenant and its first key
- Build pipeline producing runnable output in `dist/`

### Not implemented yet — intentionally

Nothing below exists in any form. It is sequenced, not forgotten.

| Area | Arrives in |
| --- | --- |
| Webhook ingestion, event persistence, idempotency | Step 4 |
| Job queue (`FOR UPDATE SKIP LOCKED`), worker claim loop, lease reaper | Step 5 |
| Workflow definition schema and the step executor | Step 6 |
| Claude integration behind an `LlmProvider` interface | Steps 7–8 |
| Connectors, credential encryption, first integration (Slack) | Steps 9–10 |
| Retry policy and backoff | Step 11 |
| Run inspection endpoints and log redaction | Step 12 |
| Distributed rate limiting, PostgreSQL RLS, CI | Step 13 |

The tables those steps need — `events`, `workflow_runs`, `step_runs`, `jobs`,
`connections`, `audit_log` — are not in the schema yet, for the same reason the
directories are empty: they arrive with the code that uses them.

Explicitly out of scope for the MVP entirely: OAuth flows, billing, a visual
workflow builder, Redis/Kafka, Kubernetes, microservices, vector stores or agent
memory, and any model training or fine-tuning.
