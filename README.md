# AI Workforce

AI-powered operations automation. Business applications are connected, a process
is described, and the platform executes it — receiving triggers, reasoning with
an LLM, calling external tools, and keeping a durable audit trail of every step.

> **Status: Step 10 of 13 — tool calling wired into Claude (end-to-end AI action).**
> The project has a PostgreSQL schema, migrations and a connection pool, a Fastify
> API with a health endpoint and tenant API-key authentication, a tenant-scoped
> service for authoring workflows and their immutable versioned definitions, a
> webhook endpoint that captures events idempotently and creates a queued workflow
> run (and its first job) atomically, a durable `jobs` queue with a worker that
> claims work under a lease (`FOR UPDATE SKIP LOCKED`) and a reaper that returns
> abandoned jobs to the queue, a workflow execution engine that advances a run by
> exactly one step per job, a framework-free LLM abstraction with a
> production-safe Claude adapter behind it, an `llm` workflow step that runs real
> AI reasoning with schema-validated structured output, the generic,
> provider-neutral **tool / connector foundation** (a tenant-scoped `connections`
> store with application-level AES-256-GCM credential encryption, a tool registry,
> and a tool executor enforcing argument validation and a hard credential
> boundary), the **first concrete connector, Slack** (a single `send_slack_message`
> tool over `chat.postMessage`), and — new in this step — **tool calling wired into
> Claude**: an `llm` step may declare tools, the model can request them across a
> bounded, per-round-metered loop, and the platform executes each one through the
> tool executor with the trusted connection bound entirely on the platform side.
> **OAuth is not implemented** (the Slack app is installed manually in development
> and its bot token stored as an encrypted connection), there is still only one
> connector, and no autonomous multi-step agent loop beyond the bounded per-step
> tool rounds. **Durable business retries with equal-jitter backoff now exist**
> (Step 11), though external side effects remain **at-least-once** — a crash or
> retry after a tool has already acted can repeat that action.
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
| `pnpm webhooks:inspect <tenantId>` | List a tenant's recent events, workflow runs, jobs, step runs and `llm_usage` (read-only dev aid to verify ingestion, queueing and execution). |
| `pnpm runs:inspect <tenantId> <runId> [--detail]` | Assemble one safe, tenant-scoped view of a single run — run/workflow/version, event, ordered step runs, jobs, per-round `llm_usage`, reconstructed tool activity and usage totals. Summaries (byte size + secret-scrubbed preview) by default; `--detail` attaches the raw values, still secret-scrubbed. Shares the **exact** assembler and redaction layer as `GET /v1/runs/:runId`. |
| `pnpm connections create <tenantId> <provider> "<name>" '<credentialJson>'` | **Dev-only.** Create an external-service connection, encrypting the credential at rest (requires `CREDENTIAL_ENCRYPTION_KEY`). Never prints the decrypted secret or the key. To keep a token out of shell history, omit the trailing JSON and pass it via the `CONNECTION_CREDENTIAL_JSON` env var instead. |
| `pnpm connections list <tenantId>` | List a tenant's connections — metadata only (id, provider/name, status, last-used), never the secret. |
| `pnpm connections disable <tenantId> <connectionId>` | Disable a connection so it can no longer be resolved for a tool run. |
| `pnpm slack:smoke <tenantId> <connectionId> [channel]` | **Optional live Slack check** (not part of `pnpm test`). Resolves the trusted Slack connection and posts **one** harmless message (`"AI Workforce Slack connector test"`) to the channel (default `#ai-workforce-test`). Prints only safe metadata (tool, provider, connection id, channel, success, latency, Slack `ts`); never the token. Reports "NOT executed" and exits cleanly if the key or an active slack connection is absent. |
| `pnpm llm:smoke ["question"]` | **Optional live Claude check.** Makes one real API call *only* if a credential (`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`) is set; prints normalized model/tokens/latency + answer and the endpoint origin (never the key/token). Tests plain then structured output, reporting each separately. Exits cleanly with a message when no credential is set. |
| `pnpm llm:tool-smoke <tenantId> <connectionId> [channel]` | **Optional live end-to-end tool-calling check** (not part of `pnpm test`). Runs the real `llm` handler with a real Claude provider and the real Slack connector: Claude requests `send_slack_message`, the platform executes it, and the model finalizes. Prints only safe metadata (rounds, per-round token counts, final output); never the API key, auth token, or bot token. Reports "NOT executed" and exits cleanly if the Claude credential, encryption key, or connection is absent. |
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
| `GET` | `/v1/runs/:runId` | Bearer key | Inspect one of the caller's own runs — the same safe, summarized view the CLI renders. `404` (identical shape) if the run does not exist **or** belongs to another tenant. |

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

#### Inspecting a run (`GET /v1/runs/:runId`)

Returns one coherent, tenant-scoped view of a run: its identity and status, the
workflow and pinned version, the triggering event, step runs in execution order,
the jobs behind them, per-round `llm_usage`, reconstructed tool activity, and
usage totals.

```bash
curl -s http://127.0.0.1:3000/v1/runs/<runId> \
  -H "Authorization: Bearer awk_your_key_here"
```

The tenant is always derived from the API key (`request.auth.tenantId`) — the URL
carries only the run id, and no `tenantId` is ever accepted from the path, query
or body. A run that belongs to another tenant is indistinguishable from one that
never existed: **both return the exact same `404`** (`{ code: "not_found" }`), so
the endpoint cannot be used to probe for the existence of other tenants' runs.

The API is deliberately **summary-only**: it never exposes raw context, payloads,
step inputs/outputs, `locked_by`, `lease_expires_at`, or trigger secrets. Instead
each value is reported as a `ValueSummary` — its true byte size plus a capped,
secret-scrubbed preview — and a live worker lease is collapsed to a single
`leased` boolean. Stored errors are reduced to `{ code, message, retryable? }`.
There is intentionally **no `?detail=` query parameter** on the API yet; the raw
(still secret-scrubbed) values are available only through the CLI's `--detail`
flag, which an operator runs against the database directly.

Both surfaces call the same `RunInspectionRepository` and the same pure
`assembleRunInspection` assembler ([`run-inspection.ts`](src/domain/run-inspection.ts)),
so the CLI and the endpoint cannot drift: the shaping and redaction live in exactly
one place. Redaction ([`redaction.ts`](src/domain/redaction.ts)) is a
**best-effort safety net, not a DLP system** — it scrubs high-confidence secret
shapes (bearer/Slack/API-key/long-hex tokens and secret-named JSON keys), caps
preview size, and bounds scrub depth.

> **Tool activity is reconstructed, not persisted.** There is no `tool_executions`
> table; a step's tool use is inferred from its `llm_usage` round count (more than
> one round ⇒ tools were used, `toolRounds = rounds − 1`). The exact tool names and
> arguments are not surfaced. A dedicated tool-execution/idempotency ledger is
> deferred (see below).

> **Designed but not built: `GET /v1/runs` (list).** A paginated, filterable list
> of runs was scoped and deliberately left out of Step 12 to keep the surface
> minimal — there is no list, search, pagination, filtering, or any
> mutation/cancellation endpoint, and no frontend. Only the single-run read exists.

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
  dispatcher — logging `job_claimed`, then `job_completed`, `job_failed`, or
  `job_retry_scheduled` when a retryable step failure defers the job;
- a **reaper** that periodically returns jobs whose lease has expired to `pending`
  (incrementing `attempt`, **never** the business `retry_count`), so a job held by
  a crashed worker is never lost — logging `job_requeued` when it recovers any.

Two workers can run at once without ever claiming the same job; that guarantee is
PostgreSQL's, via `FOR UPDATE SKIP LOCKED`, not the application's.

> **The worker now executes steps.** The dispatcher is the real
> [`WorkflowExecutor`](src/repositories/execution-engine.ts): each claimed job
> advances its run by **exactly one step**. In one transaction it records a
> `workflow_step_runs` row, updates the run's context and status, and either
> enqueues the single next step's job or finishes the run — atomically. A step
> failure marks the step run and the run `failed`, enqueues nothing, and fails the
> queue job; a **retryable** failure with business budget remaining instead records
> the failed attempt and defers the same job (Step 11 — see [Current status](#current-status)).
> A redelivered job for a run that
> has already advanced (or finished) does no work. The engine runs the version the
> run pinned at creation, never the currently-active one, and scopes every
> statement to the job's tenant. Two step types are registered: `noop` and `llm`
> (see [The `llm` workflow step](#the-llm-workflow-step)).
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
| `ANTHROPIC_API_KEY` | *(unset)* | **Optional secret.** Direct-Anthropic credential, sent as `x-api-key`. Only needed by code paths that call Claude; the app boots without it. Never logged, persisted, or returned to clients. |
| `ANTHROPIC_AUTH_TOKEN` | *(unset)* | **Optional secret.** Bearer token for an Anthropic-*compatible* gateway, sent as `Authorization: Bearer …`. **Mutually exclusive** with `ANTHROPIC_API_KEY` — set exactly one; configuring both is refused at startup. |
| `ANTHROPIC_BASE_URL` | *(unset)* | Optional. Points the provider at an Anthropic-compatible gateway instead of `https://api.anthropic.com`. Give the **origin only** (optionally with a base path); do **not** include `/v1` — the SDK appends `/v1/messages` itself, so a trailing `/v1` would produce `/v1/v1/messages` (rejected at startup). |
| `ANTHROPIC_MODEL` | `claude-opus-5` | The model the provider defaults to when a request names none. A deployment decision; any request may override it. Against a gateway, this must be a model id **that gateway accepts** — the default is not guaranteed to be valid there. |

`.env` is loaded by Node's built-in `--env-file-if-exists`, so no `dotenv`
dependency is involved. Validation of `DATABASE_URL` is structural only — scheme,
host and database name — and never echoes the URL in an error, because it carries
a password and these messages go to stderr.

`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are deliberately **optional**: the
API and worker start without any Claude credential, and only fail — clearly, at
the provider boundary — if something actually tries to construct a Claude
provider without one. They are secrets and are treated as such everywhere: never
logged, never persisted, never placed in an error object, and never returned to
an API client. Provider credentials (key or token) are **local secrets** — keep
them in `.env`, never in `.env.example` or version control.

### Direct Anthropic vs. an Anthropic-compatible gateway

The same [`ClaudeProvider`](src/llm/claude-provider.ts) serves both, chosen purely
by configuration — no vendor-specific code path:

- **Direct Anthropic** — set `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`).
  Requests authenticate with `x-api-key` against the default base URL.
- **Anthropic-compatible gateway** — set `ANTHROPIC_AUTH_TOKEN` **and**
  `ANTHROPIC_BASE_URL`. Requests authenticate with `Authorization: Bearer …`
  against the gateway, which must speak the same `/v1/messages` protocol.

Auth resolution is explicit: a token present → bearer; otherwise a key present →
`x-api-key`; **both** present → configuration refused; **neither** → provider
construction fails the moment a Claude call is attempted.

> **Structured-output compatibility.** `completeStructured` uses the Anthropic
> SDK's schema-constrained output (`messages.parse` + `zodOutputFormat`). Plain
> text completion is broadly portable across compatible gateways, but structured
> output depends on the gateway supporting those request fields — it is **not**
> guaranteed. Verify it against your gateway with `pnpm llm:smoke`, which tests
> plain completion first and structured output second, reporting each separately.

## LLM provider

The system talks to a large language model through one small, vendor-neutral
seam — [`LlmProvider`](src/domain/llm.ts) — and nothing outside the adapter knows
which vendor is behind it. The seam names only the capabilities actually needed
today: text completion, schema-constrained structured output, and normalized
token/latency/model metadata. It is framework-free (its only third-party import
is Zod, already used pervasively for validation), so the engine and future
workflow steps depend on the interface, never on any SDK.

[`ClaudeProvider`](src/llm/claude-provider.ts) is the single implementation and
the **only** place in the codebase that imports `@anthropic-ai/sdk`. It:

- **owns one SDK client**, built from constructor config — it never reads
  `process.env` itself. `createClaudeProvider(env, logger)` is the one bridge from
  validated `Env` to a provider, and it fails clearly if no credential is present.
  Configuration selects the transport: an `ANTHROPIC_API_KEY` authenticates
  directly with Anthropic via `x-api-key`, while an `ANTHROPIC_AUTH_TOKEN` plus
  `ANTHROPIC_BASE_URL` targets an Anthropic-compatible gateway with a bearer token
  (setting both credentials is refused). This is why the application boots without
  a credential: nothing constructs a provider until a Claude call is actually
  needed.
- **normalizes requests and responses.** Callers pass a vendor-neutral
  `LlmCompletionRequest` (system, messages, model, `maxOutputTokens`, optional
  `temperature`/`timeoutMs`/`signal`) and receive an `LlmCompletion` (text, model,
  `{inputTokens, outputTokens, totalTokens}`, latency, provider). Raw SDK objects
  never escape the boundary.
- **does structured output the SDK's way** — `messages.parse()` with
  `zodOutputFormat(schema)`, not "return JSON" + ad-hoc parsing — then
  defensively re-validates against the Zod schema. A mismatch (or a null parse) is
  a `PermanentError` (`llm_structured_parse_failed`); malformed data never reaches
  workflow context.
- **maps errors by SDK class, never by string** onto the shared taxonomy.
  *Retryable*: abort/timeout, connection failure, `429`, and transient `408`/`5xx`.
  *Permanent*: bad key (`401`/`403`), invalid request (`400`/`422`), unknown model
  (`404`), a refusal `stop_reason`, and — crucially — any *unrecognised* error, so
  an unknown failure can never accidentally become retryable. The provider
  **classifies but does not retry**: deciding whether to retry is the engine's job
  (Step 11). The SDK's own retry loop is disabled (`maxRetries: 0`).
- **times out and cancels** via a default timeout (`60s`, overridable per config
  or per request) and an optional `AbortSignal` wired straight through.
- **logs metadata only** — provider, model, latency, token counts, and on failure
  an `err_code`. Never the API key, the prompt, or the response body. Raw SDK
  errors (which may carry credentials or payloads) are never re-thrown to callers;
  only a redacted `AppError` escapes.
- **never touches the database.** Usage is returned on the result; persisting it
  is the caller's responsibility (a later step), keeping the provider free of
  infrastructure concerns.

The model is injectable (`ANTHROPIC_MODEL`, default `claude-opus-5`, overridable
per request) — there is no hardcoded model string in business logic. Note that
current Claude models reject sampling parameters, so setting `temperature` against
them surfaces as a permanent invalid-request error rather than being silently
ignored; `temperature` is kept on the neutral interface because the seam is
provider-generic.

To confirm it end-to-end against the live API (optional, key-gated):

```bash
pnpm llm:smoke "In one sentence, what is a workflow?"
```

> **The provider is a seam, not a workflow step.** The provider on its own only
> knows how to talk to a model; it is the [`llm` workflow step](#the-llm-workflow-step)
> (Step 8) that wires it into the execution engine, and [tool calling](#tool-calling-in-the-llm-step-step-10)
> (Step 10) that lets the model drive real external action. There is still no
> autonomous agent loop beyond a step's bounded tool rounds, no MCP, no RAG, no
> embeddings, no prompt caching and no streaming — those are deliberately absent.

## The `llm` workflow step

Step 8 turns the provider seam into a real workflow capability: a step type that
performs AI reasoning and returns **schema-validated structured output**, wired
into the same one-step-per-job execution engine as every other step.

The path is a clean chain of the seams already in place:

```
LlmStepHandler → LlmProvider → ClaudeProvider
```

- [`LlmStepHandler`](src/domain/step-handler.ts) is pure domain logic. It depends
  only on the vendor-neutral `LlmProvider` interface — it does **not** import
  `@anthropic-ai/sdk`, know any vendor specifics, or touch the database. It
  compiles the step's declarative output schema, calls
  `provider.completeStructured(...)`, and returns the validated object plus token
  usage as a `StepResult`.
- `LlmProvider` is the same vendor-neutral seam described above.
- [`ClaudeProvider`](src/llm/claude-provider.ts) remains the single adapter and the
  only importer of the SDK.

When no credential is configured the worker registers an
`UnconfiguredLlmStepHandler` instead, so the process still boots; a run that
reaches an `llm` step then fails cleanly with `llm_provider_not_configured`
rather than crashing at startup.

### Prompt-injection trust boundary

The step keeps the workflow author's **static** instructions and the run's
**untrusted** input strictly separate. The step's `system` text becomes the
model's SYSTEM turn; the resolved `input` becomes a USER message. They are never
concatenated into one string, so data flowing through a run cannot rewrite the
instructions.

### Declarative, data-only output schema

An `llm` step must declare the shape it expects back, as **data, not code**. The
schema lives in the workflow definition (which is stored JSON and may one day be
authored by an AI), so there is no `eval`, no arbitrary JavaScript, and no
caller-supplied validator function. [`src/domain/output-schema.ts`](src/domain/output-schema.ts)
is the single authority on the format:

- The supported subset is deliberately tiny: `object`, `string`, `number`,
  `boolean`, string `enum`, and simple `array`. The root must be an `object`.
- It is **not** full JSON Schema. `$ref`, combinators (`anyOf`/`oneOf`),
  `pattern`, `format`, `type: "integer"` and recursion are all rejected — every
  node is validated with Zod `.strict()`, so an unsupported construct fails at
  workflow-definition time instead of being silently ignored.
- Nesting is allowed but depth-bounded (`MAX_SCHEMA_DEPTH = 10`), so a
  pathological document cannot blow the stack while compiling.
- Free-text fields (`description`, enum values) forbid the `{{` reference token, so
  the schema stays static, trusted structure that the engine's reference
  resolution never rewrites.

At run time the validated declarative schema is compiled to a Zod schema, handed
to the provider's structured-output mode, and the model's response is re-validated
against it. Unknown keys are stripped; a response that violates the schema is a
`PermanentError`, never partially-valid data leaking into workflow context.

### Usage accounting

Each successful `llm` step records one row in the `llm_usage` table (provider,
model, token counts, latency) **atomically with the step-run settle**, in the same
transaction the engine already uses. The provider itself never writes to the
database — it returns usage on its result and the engine persists it. Only
metadata is stored: never the prompt, the model output, or any credential.

## Tool calling in the `llm` step (Step 10)

Step 10 closes the loop between AI reasoning and real external action. An `llm`
step may now declare **tools**; the model can request them, and the platform
executes each requested tool through the same [`ToolExecutor`](src/domain/tool-executor.ts)
and Slack connector built in Step 9, feeding only safe, normalized results back to
the model until it produces its final schema-validated output.

The whole loop lives in [`LlmStepHandler`](src/domain/step-handler.ts) — the engine
still advances **one run by exactly one step per job**; a step's several
model↔tool rounds are internal to that one step.

### What a tool step declares

```jsonc
{
  "key": "notify",
  "type": "llm",
  "config": {
    "system": "…static, developer-authored instructions…",
    "input": "{{trigger.payload.text}}",
    "output_schema": { "type": "object", "properties": { "summary": { "type": "string" } }, "required": ["summary"] },
    "tools": [{ "name": "send_slack_message", "connection_id": "<uuid>" }],
    "max_tool_rounds": 4
  }
}
```

`name` must be a **platform-registered** tool (the registry is the source of
truth); `connection_id` is **trusted workflow config**, structurally separate from
the model's argument path.

### The trust boundary (two maps)

The handler builds two maps once, and the split is the whole security model:

- **Model-facing** — the model is offered only `{ name, description, inputSchema }`
  per tool, taken from the registry. It never sees a `connection_id`, a tenant id,
  a credential, or the provider binding.
- **Platform-side** — a `Map<toolName, ConnectionRef>` holds the trusted binding.
  Its `provider` is sourced from the **registry** (`tool.provider`), never from
  config; its `connectionId` comes from the trusted step config. When the model
  requests a tool, that `ConnectionRef` is passed to the executor as a **separate
  argument** — never assembled from the model's `call.arguments`.

Everything the executor then does is unchanged from Step 9: resolve the tool,
validate arguments with the connector's `.strict()` schema, authorize the ref
(provider must match), resolve+decrypt the credential **tenant-scoped**, call the
connector, normalize the result. The decrypted bot token flows to the Slack client
and nowhere else.

### The bounded loop

`for (round = 1 … max_tool_rounds)`: call `provider.converse(...)` with the system
turn, the running message history, the model-facing tool defs and the compiled
output schema. Each round is **metered as its own `llm_usage` row** (see below).

- **`final`** → return the validated structured output; done.
- **`tool_use`** → record the request, run each call, feed back **only** a safe
  `{ output }` or `{ code, message }` per call, and loop.
- A tool the model was **not** offered is refused as `unknown_tool` **without ever
  reaching the executor**.
- A tool failure is normalized to `{ code, message }` — never a credential,
  connection metadata, tenant id, encrypted envelope, or internal error.
- Rounds exhausted without a final answer → `llm_tool_rounds_exceeded`
  (`PermanentError`); the run fails deterministically. **No retries** (Step 11).

If a step declares tools but the handler has no tool registry / resolver (or no
tenant to scope connections), it fails cleanly with `llm_tools_not_configured`
rather than running blind.

### Per-round usage

The `llm_usage` table gained a **`round`** column (migration `0008`), and its
uniqueness moved from `(step_run_id)` to `(step_run_id, round)`. A tool-calling
step therefore records **one row per provider round** — all tied to the one
step-run, still written **atomically with the step settle**, still metadata-only.

### Live end-to-end smoke (optional, credential-gated)

The automated suite proves the loop with a deterministic fake provider and fake
Slack transport — it never calls a live model or Slack. To confirm the real
Claude→Slack path by eye:

```bash
pnpm llm:tool-smoke <tenantId> <connectionId> "#ai-workforce-test"
```

It runs the real handler with a real Claude provider and the real Slack connector
against a stored connection. Missing a Claude credential, the encryption key, or
the connection → it prints `live smoke: NOT executed` and exits 0. It prints only
safe metadata (rounds, per-round token counts, the final output) — never the API
key, auth token, or bot token.

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
├── cli/                      create-tenant.ts, create-api-key.ts, create-workflow.ts, inspect-webhooks.ts, llm-smoke.ts, connections.ts, slack-smoke.ts, llm-tool-smoke.ts (bootstrap/dev)
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
│   ├── workflow-definition.ts  Zod schema for linear workflow definitions (noop + llm steps)
│   ├── workflow-trigger.ts   Zod schema for webhook trigger config
│   ├── workflow-run.ts       Run-context builder (trigger facts + empty steps)
│   ├── run-state.ts          Run-status state machine (queued→running→succeeded/failed)
│   ├── execution-context.ts  Framework-free trigger + step-output accessor
│   ├── references.ts         No-eval {{trigger.*}} / {{steps.*.output}} resolver
│   ├── step-handler.ts       StepHandler interface + registry (noop, llm)
│   ├── output-schema.ts       Declarative, data-only output schema → compiled Zod
│   ├── queue.ts             Framework-free Queue contract + InvalidJobTransitionError
│   └── llm.ts               Framework-free LlmProvider seam + request/response/usage types
├── llm/
│   └── claude-provider.ts    ClaudeProvider — the only importer of @anthropic-ai/sdk
└── test/
    ├── unit/                 No external dependencies
    ├── support/              Shared test doubles (e.g. a deterministic fake LlmProvider)
    └── integration/          Requires PostgreSQL; skipped without it
drizzle/                      Generated SQL migrations + snapshots (committed)
drizzle.config.ts             drizzle-kit config (tooling, not application code)
```

One codebase, two deployable processes. They share all domain code by direct
import, and are separate processes because they fail and scale differently — a
slow LLM call must never block webhook ingestion.

Directories for future concerns (`engine/`, `queue/`, `connectors/`,
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

Eleven tables so far. Two rules drive the shape of all of them.

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
| `workflow_runs` | One execution of a workflow, born from an event | Pins `workflow_id` + `workflow_version_id` + `event_id`; `status` (starts `queued`), `context` jsonb. Advanced one step per job by the execution engine. |
| `jobs` | A unit of durable work advancing a run's step | `step_key`, `attempt` (crash/lease recovery) / `retry_count` (business retries) / `max_attempts` (business budget), `status` (`pending`→`running`→`done`/`failed`), `run_at` (a retry's future defer lives here), `locked_by` + `lease_expires_at` (the lease), `last_error`. Claimed with `FOR UPDATE SKIP LOCKED`. |
| `workflow_step_runs` | One executed step of a run | Records the step's `status`, `output` jsonb and error, one row per step the engine advances. Composite tenant-safe FK to its run. |
| `llm_usage` | Token/latency accounting for one provider round of an `llm` step | `provider`, `model`, `round`, `input_tokens`/`output_tokens`/`total_tokens`, `latency_ms`. Written atomically with the step-run settle; `UNIQUE(step_run_id, round)`. A no-tools step meters one round; a tool-calling step meters one row per request→execute round. Metadata only — never the prompt, output or credential. |
| `api_keys` | A tenant's bearer credentials | Stores a SHA-256 `key_hash` and a short `prefix`, never the key. `revoked_at` disables one. |
| `connections` | A tenant's authorization to act against an external provider | `provider`, `name`, `status` (`active`/`disabled`/`error`), `encrypted_credentials` jsonb (a versioned AES-256-GCM envelope — never plaintext), non-secret `metadata`, `last_used_at`. `UNIQUE(tenant_id, id)` for future composite FKs and `UNIQUE(tenant_id, provider, name)` for distinct names. A tenant may hold **many active connections to the same provider** (e.g. two Slack workspaces); which one a tool uses is decided by a trusted `connectionId` in platform/workflow config — never by the model. |

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
authoring they cover definition validation (valid `noop` and `llm` steps accepted;
empty steps, duplicate keys, bad key format, unknown step type, malformed config,
`{{` in an `llm` system prompt, and unsupported output-schema constructs all
rejected) and trigger-config validation. The declarative output schema is covered
in isolation — the accepted subset, rejection of non-object roots / unknown types
/ extra keys / `{{` text / empty enums / undeclared `required`, and compilation to
Zod (missing-required, bad enum, wrong type, optionality, unknown-key stripping).
The `llm` step handler is covered with a deterministic fake provider: a single
provider call, the compiled schema passed through, the system/user trust boundary,
model override forwarding, non-string input stringified, and `PermanentError`
propagation. The worker loop is covered with an in-memory fake
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
that a tenant-scoped queue can neither claim nor mutate another tenant's jobs. For
**retries** (Step 11) they prove — in pure unit tests for the equal-jitter policy,
and against real PostgreSQL for the queue and engine — that `retry` moves a running
job back to `pending` with a future `run_at` while bumping `retry_count` (never
`attempt`), that a deferred job is unclaimable until its `run_at` elapses, that
crash recovery via the reaper never spends the business budget, that the retry vs.
reaper race is safe (whoever loses the guarded UPDATE does nothing), that the engine
schedules a retry (leaving the run non-terminal) then exhausts the budget into a
terminal failure across the right number of attempts, and that a `PermanentError`
never retries.
For the **`llm` step end-to-end** they drive the real execution engine with a fake
provider against PostgreSQL: an `llm` step succeeds and writes exactly one
`llm_usage` row, `llm` composes with `noop` steps in a run, the pinned version is
executed, a schema-mismatch fails the run without enqueuing a next job or writing
usage, a redelivered `llm` job calls the provider only once (idempotency), and one
tenant's run cannot touch another's. Because they write and delete rows, they
refuse to run unless the database name contains `test`.

For **run inspection (Step 12)** the pure assembler and redaction policy are
covered without a database: dates map to ISO strings, values are summarized by
default and only attached (secret-scrubbed) in detail mode, the three job counters
(`attempt`/`retry_count`/`max_attempts`) stay distinct, `leased` is true only for a
running job with an unexpired lease (and the worker id is never exposed), `llm_usage`
is attributed to step keys and ordered, tool activity is reconstructed from round
counts, and a stored error is reduced to its safe shape; the redaction unit tests
pin the secret patterns, the value-summary size/cap/boundary behaviour, and the
non-mutating bounded deep scrub. The `GET /v1/runs/:runId` boundary is driven by
`app.inject` over a fixture built from the **real** assembler with secrets planted:
an authenticated own-run returns `200` with byte-for-byte the shared DTO, a missing
key `401`, and another tenant's run and a nonexistent run both return an **identical**
`404` — with the planted secrets, `locked_by` and `lease_expires_at` all absent from
the body and a `requestId` present in the error envelope. The integration suite
proves the same against real rows: one run assembles coherently under the tenant
predicate, step ordering and usage attribution hold, secrets are scrubbed in both
summary and detail mode, a cross-tenant or nonexistent run returns `null`, and
`leased` reflects a live lease.

## Current status

### Implemented (Steps 1–12)

- pnpm + ESM + strict TypeScript project setup, Node 24 pinned
- Fail-fast, Zod-validated environment configuration
- Structured pino logging with a `withContext` helper for `tenant_id`,
  `run_id`, `step_run_id`
- `RetryableError` / `PermanentError` taxonomy
- PostgreSQL schema for `tenants`, `users`, `workflows`, `workflow_versions`,
  `events`, `workflow_runs`, `workflow_step_runs`, `jobs`, `llm_usage`, `api_keys`,
  `connections`, with time-ordered UUIDv7 primary keys generated application-side
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
  (linear steps: unique valid keys, at least one step, no unknown step types or
  config; `noop` at first, with `llm` added in Step 8) and a `webhook` trigger
  config, both framework-free and
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
  created in the same transaction as the event and run. At this step **no step
  executed yet** — the dispatcher was a stub that refused every step and the
  worker recorded that as a terminal failure, never marking a job `done`; the real
  execution engine arrives in Step 6.
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
  the worker (`noop`, yielding `{ ok: true }`, at this step; `llm` joined it in
  Step 8). Idempotency
  under at-least-once delivery is two-layered: a `SELECT … FOR UPDATE` on the run
  plus a "has this run already advanced past this step?" guard, backed by a
  partial unique index (one success per `run_id`+`step_key`+`attempt`). The run
  executes its **pinned** `workflow_version_id`, never the currently-active one;
  every statement is tenant-scoped. A failure marks the step run and run `failed`
  and enqueues nothing (no retries — Step 11). `webhooks:inspect` now also lists
  step runs. Structured logs: `step_started`, `step_succeeded`, `step_failed`,
  `run_advanced`, `run_succeeded`, `run_failed`.
- **Claude LLM provider (Step 7)** — a framework-free
  [`LlmProvider`](src/domain/llm.ts) seam (text completion, Zod-schema structured
  output, normalized usage/latency/model) and a single
  [`ClaudeProvider`](src/llm/claude-provider.ts) behind it — the only importer of
  `@anthropic-ai/sdk`. It owns one SDK client built from constructor config
  (`createClaudeProvider` is the one bridge from `Env`; missing key fails clearly,
  so the app still boots without a key), normalizes requests/responses so no raw
  SDK object escapes, does structured output via `messages.parse` +
  `zodOutputFormat` with defensive re-validation (parse failure → `PermanentError`),
  maps SDK errors **by class** onto `RetryableError`/`PermanentError` (unknown
  errors are never retryable) while classifying-not-retrying with `maxRetries: 0`,
  honours a default/overridable timeout and `AbortSignal`, and logs metadata only
  (never key, prompt or response). Usage is returned, never persisted — the
  provider never touches the DB. The model is config-injectable
  (`ANTHROPIC_MODEL`, overridable per request). An optional key-gated
  `pnpm llm:smoke` exercises the live API. The provider is the seam only; wiring it
  into a workflow step is Step 8.
- **`llm` workflow step (Step 8)** — the first AI-reasoning step type, wired as
  `LlmStepHandler → LlmProvider → ClaudeProvider`. The handler is pure domain logic
  depending only on the vendor-neutral `LlmProvider` (no SDK import, no DB access):
  it keeps the workflow author's static `system` instruction and the run's
  untrusted `input` as **separate** SYSTEM/USER turns (a prompt-injection trust
  boundary), calls `completeStructured`, and returns validated structured output
  plus usage. Each step declares its expected output as a **declarative, data-only
  schema** ([`output-schema.ts`](src/domain/output-schema.ts)) — a deliberately
  tiny JSON-Schema subset (`object`/`string`/`number`/`boolean`/string `enum`/
  simple `array`, root always an object), Zod-`.strict()`-validated so unsupported
  constructs (`$ref`, combinators, `pattern`, `integer`, recursion, executable
  code) are rejected at definition time, depth-bounded, and forbidding `{{` in
  free text. The schema compiles to Zod, constrains the model's output, and
  re-validates the response; unknown keys are stripped and a violation is a
  `PermanentError`. The engine persists a metadata-only `llm_usage` row atomically
  with the step-run settle (never prompt/output/credential). With no credential the
  worker registers an `UnconfiguredLlmStepHandler`, so the app still boots and an
  `llm` step fails cleanly with `llm_provider_not_configured`. At this step the
  step reasoned over the run's own context only — **tool calling, connectors and
  an agent loop were not yet present**; those arrive in Steps 9–10.
- **Tool / connector foundation (Step 9A)** — the generic, provider-neutral
  architecture a real connector will plug into, plus the credential boundary, and
  nothing service-specific. A tenant-scoped `connections` store keeps external
  credentials encrypted at rest with **application-level AES-256-GCM**
  ([`credential-cipher.ts`](src/security/credential-cipher.ts)): a fresh random IV
  per encryption, a GCM tag verified before any plaintext is returned, a 256-bit key
  supplied only via `CREDENTIAL_ENCRYPTION_KEY` (never in the DB, never logged, never
  returned by the API), and a versioned envelope (`{v,alg,iv,ct,tag}`) shaped for
  future key rotation without a migration. The app still boots without the key;
  only an actual encrypt/decrypt fails clearly when it is missing. A framework-free
  [`ToolDefinition`](src/domain/tool.ts) binds a name + description + Zod
  `inputSchema` to a `Connector` (no URL, method, script or shell — a tool can only
  do what its reviewed connector code does); a [`ToolRegistry`](src/domain/tool-registry.ts)
  registers/resolves tools (duplicate and unknown both rejected) and lists metadata
  only. The [`ToolExecutor`](src/domain/tool-executor.ts) enforces a fixed order —
  resolve tool → **validate arguments** (invalid args fail before anything external)
  → authorize the connection reference (which comes from trusted config, **never the
  model's arguments**) → resolve the tenant-scoped connection → decrypt at the
  execution boundary only → run the connector → normalize to a `ToolResult` whose
  error is classified and which never carries the credential. A
  [`ConnectionRepository`](src/repositories/connection-repository.ts) owns the one
  narrow decrypt path (`resolveForTool`) and metadata operations that never return
  the secret; a dev-only `pnpm connections` CLI (create/list/disable) exercises it.
  A tenant may hold **many active connections to the same provider**; the connection
  a tool uses is chosen by a trusted `connectionId`, never by the model.
- **Slack connector (Step 9B)** — the first concrete connector, built entirely on the
  9A foundation. A single [`SlackConnector`](src/connectors/slack/slack-connector.ts)
  exposes one tool, `send_slack_message`, with a `.strict()` Zod schema of exactly
  `{ channel, text }` (unknown fields — including any model-supplied `connectionId`/
  `tenantId` — are rejected before resolution). The connector calls Slack's
  `chat.postMessage` (`POST https://slack.com/api/chat.postMessage`, bot scope
  **`chat:write`**) through a tiny fixed-endpoint client
  ([`slack-client.ts`](src/connectors/slack/slack-client.ts)) — **no arbitrary HTTP**;
  the bot token flows from the decrypted `{ botToken }` credential to that client and
  nowhere else (never in the result, logs, or errors). Slack failures map onto the
  error taxonomy: `invalid_auth`/`channel_not_found`/`not_in_channel`/`missing_scope`/
  etc. are **permanent**, while 429 (with `Retry-After` kept as safe metadata), 5xx and
  network/timeouts are **retryable** — classified but **never retried here** (Step 11).
  Success normalizes to `{ ok, channel, ts }`. **OAuth is not implemented** — the Slack
  app is installed manually in development and its bot token stored as an encrypted
  connection. Tool calling is now **wired into Claude** (Step 10, below). A `pnpm
  slack:smoke` command posts one live test message when configured; the automated
  suite never touches the live Slack API.
- **LLM tool calling (Step 10)** — the `llm` step can now offer registered tools to
  the model and execute the ones it requests, closing the loop between AI reasoning
  and real external action. The bounded loop lives entirely in
  [`LlmStepHandler`](src/domain/step-handler.ts); the engine's one-job-one-step
  contract is unchanged. Two maps enforce the trust boundary: the model is offered
  only `{name, description, inputSchema}` per tool (from the registry), while a
  platform-side `Map<toolName, ConnectionRef>` holds the **trusted connection
  binding** — its `provider` sourced from the registry, its `connection_id` from
  trusted step config, never from a model argument. When the model requests a tool,
  that `ConnectionRef` is passed to the `ToolExecutor` as a separate argument (the
  full Step 9 security order: validate args → authorize → tenant-scoped decrypt →
  connector → normalize); only the connector's **normalized, non-secret result** —
  or a safe `{code, message}` — is fed back. A tool the model was not offered is
  refused as `unknown_tool` without reaching the executor. The loop is bounded by
  `max_tool_rounds` (exhaustion → `llm_tool_rounds_exceeded`, a `PermanentError`);
  a step declaring tools with no registry/resolver or no tenant fails cleanly with
  `llm_tools_not_configured`. Each provider round is metered as its own `llm_usage`
  row (`round` column, `UNIQUE(step_run_id, round)` — migration `0008`), all written
  atomically with the step-run settle. Integration and unit tests prove the loop
  with a deterministic **fake provider** and fake Slack transport (no live model or
  Slack); an optional, credential-gated `pnpm llm:tool-smoke` confirms the real
  Claude→Slack path. **No retries** (Step 11), one connector, no OAuth, no MCP, and
  no autonomous agent loop beyond a step's bounded rounds.
- **Retries, backoff & failure recovery (Step 11)** — a step failure is no longer
  automatically terminal. The engine distinguishes two independent counters and one
  budget on `jobs`: `attempt` (crash/lease recovery, owned by the reaper),
  `retry_count` (business retries), and `max_attempts` (the business budget). When a
  handler raises a **`RetryableError`** and `retry_count < max_attempts`, the engine
  records the failed `workflow_step_runs` attempt, leaves the run **non-terminal and
  untouched** (never marked `failed`), and the worker moves the same queue job back
  to `pending` with a future `run_at` — so the deferral is **fully durable** (no
  `sleep`/`setTimeout`/in-memory loop; the wait lives on the row and is enforced by
  claim's `run_at <= now()` predicate). The delay is **equal-jitter** exponential
  backoff (`raw = min(baseMs·factor^retry_count, maxDelayMs)`, `delay = raw/2 +
  rand·raw/2`; defaults 1s base, ×2, 5min cap, budget 5), pure and injectable
  ([`retry-policy.ts`](src/domain/retry-policy.ts)). A **`PermanentError`**, or a
  retryable one whose budget is spent, fails the run terminally on that attempt.
  Crucially the two counters never cross-contaminate: the reaper's crash recovery
  bumps only `attempt` (never spending business budget), and a business retry bumps
  only `retry_count` — the `workflow_step_runs` audit ordinal is their sum, keeping
  the "one success per (run, step, attempt)" index valid across the whole retry
  history. The retry vs. reaper race is safe (a guarded `WHERE status = 'running'`
  UPDATE: whoever loses matches no row and does nothing). Provider SDK retries stay
  disabled (`maxRetries: 0`) — retry policy belongs to this durable queue/worker
  layer, not the vendor client. **Known limitation:** external side effects are
  **at-least-once** — the tool-execution idempotency ledger is deferred, so a crash
  or retry after a tool (e.g. a Slack post) has already acted can repeat that action;
  `SlackConnector` adds no idempotency key in this step. New logs: `step_retry_scheduled`,
  `step_retry_exhausted`, `job_retry_scheduled`. Migration `0009` adds `jobs.retry_count`.
- Bootstrap CLIs for creating a tenant and its first key
- Build pipeline producing runnable output in `dist/`

### Development Slack app setup

Step 9B uses a **manually installed** Slack app (no OAuth onboarding — this is a
development path, not production SaaS onboarding):

1. Create a Slack app and install it into your development workspace.
2. Give the **bot** the `chat:write` scope — nothing broader. Do **not** add
   `chat:write.public`, `channels:read`, `channels:history`, `users:read`, or any
   `admin:*` scope.
3. Copy the **Bot User OAuth Token** (`xoxb-…`).
4. Invite the bot to your target channel (e.g. `/invite @your-bot` in
   `#ai-workforce-test`). The bot can only post to channels it is a member of; if
   Slack returns `not_in_channel`, fix membership rather than widening scopes.
5. Store the token as an **encrypted** connection (never in `.env`, a file, or
   argv — pass it via an env var so it stays out of shell history):

   ```bash
   CONNECTION_CREDENTIAL_JSON='{"botToken":"xoxb-…"}' \
     pnpm connections create <tenantId> slack "my-development-slack"
   ```

6. Post one live test message (optional, not part of `pnpm test`):

   ```bash
   pnpm slack:smoke <tenantId> <connectionId> "#ai-workforce-test"
   ```

7. Confirm the full Claude→Slack tool-calling path end to end (optional, not part
   of `pnpm test`; also needs a Claude credential):

   ```bash
   pnpm llm:tool-smoke <tenantId> <connectionId> "#ai-workforce-test"
   ```

### Not implemented yet — intentionally

Nothing below exists in any form. It is sequenced, not forgotten.

| Area | Arrives in |
| --- | --- |
| Additional connectors (Gmail, GitHub, …), OAuth onboarding | later steps / not scheduled |
| Run inspection endpoints and log redaction | Step 12 |
| Distributed rate limiting, PostgreSQL RLS, CI | Step 13 |
| Tool-execution idempotency ledger (exactly-once external effects) | deferred — external effects are at-least-once until then |
| HMAC / provider signature verification on webhooks | before production webhooks |
| Agent loops, autonomous multi-step agents, MCP, RAG / embeddings, prompt caching, streaming, model training / fine-tuning, any frontend | not scheduled |

The tool / connector foundation (Step 9A), the first concrete connector — **Slack**
(Step 9B) — **tool calling wired into Claude** (Step 10), and **durable business
retries with equal-jitter backoff** (Step 11) now exist: the `connections` table,
credential encryption, the tool registry and executor, a `send_slack_message` tool
over `chat.postMessage`, an `llm` step that can offer those tools to the model and
execute the ones it requests, and a retry/backoff layer that defers retryable
failures durably on the job row. What does **not** exist yet: any other provider,
OAuth onboarding, a tool-execution idempotency ledger (so external effects are
**at-least-once** — a retry after a tool acted can repeat it), and any autonomous
agent loop beyond a single step's bounded tool rounds. A generic
`audit_log` table is deliberately still absent — the structured, metadata-only
execution record and logging stand in until the code that proves an audit schema
necessary arrives.

**Up next is Step 12** — run-inspection endpoints and log redaction, followed by
production hardening (Step 13). Each step is implemented, verified and
paused for review before the next begins.

Explicitly out of scope for the MVP entirely: OAuth flows, billing, a visual
workflow builder, Redis/Kafka, Kubernetes, microservices, vector stores or agent
memory, and any model training or fine-tuning.
