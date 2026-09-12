# AI Workforce

AI-powered operations automation. Business applications are connected, a process
is described, and the platform executes it — receiving triggers, reasoning with
an LLM, calling external tools, and keeping a durable audit trail of every step.

> **Status: backend production hardening is paused after Step 13 Items 1–3; Frontend Milestone 1 is available in `frontend/`.**
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

| Requirement | Version             | Notes                                                 |
| ----------- | ------------------- | ----------------------------------------------------- |
| Node.js     | **>= 24.0.0, < 25** | Pinned via `engines`. Verified on v24.16.0.           |
| pnpm        | **>= 10**           | Verified on 11.4.0. `npm install -g pnpm` if missing. |
| PostgreSQL  | **>= 13**           | Required from Step 2 on. Local or hosted — see below. |

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

| Command                                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev:api`                                                              | Run the API in watch mode (`tsx`), restarting on file changes.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm dev:worker`                                                           | Run the worker in watch mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm tenant:create "<name>"`                                               | Create a tenant; prints its id. Bootstrap step before minting a first key.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm apikey:create <tenantId> "<name>"`                                    | Mint an API key for a tenant. Prints the plaintext **once** — it is never retrievable again.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm workflow:create <tenantId> "<name>" [source]`                         | Author a test workflow (linear `noop` definition, `webhook` trigger) and its active version 1. Prints the ids.                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm webhooks:inspect <tenantId>`                                          | List a tenant's recent events, workflow runs, jobs, step runs and `llm_usage` (read-only dev aid to verify ingestion, queueing and execution).                                                                                                                                                                                                                                                                                                                                               |
| `pnpm runs:inspect <tenantId> <runId> [--detail]`                           | Assemble one safe, tenant-scoped view of a single run — run/workflow/version, event, ordered step runs, jobs, per-round `llm_usage`, reconstructed tool activity and usage totals. Summaries (byte size + secret-scrubbed preview) by default; `--detail` attaches the raw values, still secret-scrubbed. Shares the **exact** assembler and redaction layer as `GET /v1/runs/:runId`.                                                                                                       |
| `pnpm connections create <tenantId> <provider> "<name>" '<credentialJson>'` | **Dev-only.** Create an external-service connection, encrypting the credential at rest (requires `CREDENTIAL_ENCRYPTION_KEY` or a `legacy-v1` entry in `CREDENTIAL_ENCRYPTION_KEYS`). Never prints the decrypted secret or the key. To keep a token out of shell history, omit the trailing JSON and pass it via the `CONNECTION_CREDENTIAL_JSON` env var instead.                                                                                                                                                                                  |
| `pnpm connections list <tenantId>`                                          | List a tenant's connections — metadata only (id, provider/name, status, last-used), never the secret.                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm connections disable <tenantId> <connectionId>`                        | Disable a connection so it can no longer be resolved for a tool run.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm connections rotate <tenantId> [--connectionId <id>] [--dry-run] [--batch-size <N>]` | **Operator-only.** Re-encrypt every connection whose envelope `kid` is not the current active kid under the active key with `${tenantId}:${connectionId}` AAD binding. Pages via keyset cursors; each row is a short transaction (`SELECT … FOR UPDATE` + re-checked predicate + decrypt + re-encrypt + commit). `--dry-run` enumerates the same rows and performs the same cryptographic validation but writes **nothing**; per-row output is `would-rotate` or `would-fail <reason>` (`decrypt_failed`, `unknown_kid`, `legacy_v1_key_missing`, `malformed_envelope`). Exit codes: `0` clean, `1` partial, `2` total failure or misconfiguration. Requires `CREDENTIAL_ENCRYPTION_KEYS` with a real active kid; the legacy var alone is not enough. Never prints the decrypted secret or the key. |
| `pnpm slack:smoke <tenantId> <connectionId> [channel]`                      | **Optional live Slack check** (not part of `pnpm test`). Resolves the trusted Slack connection and posts **one** harmless message (`"AI Workforce Slack connector test"`) to the channel (default `#ai-workforce-test`). Prints only safe metadata (tool, provider, connection id, channel, success, latency, Slack `ts`); never the token. Reports "NOT executed" and exits cleanly if the key or an active slack connection is absent.                                                     |
| `pnpm llm:smoke ["question"]`                                               | **Optional live Claude check.** Makes one real API call _only_ if a credential (`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`) is set; prints normalized model/tokens/latency + answer and the endpoint origin (never the key/token). Tests plain then structured output, reporting each separately. Exits cleanly with a message when no credential is set.                                                                                                                                 |
| `pnpm llm:tool-smoke <tenantId> <connectionId> [channel]`                   | **Optional live end-to-end tool-calling check** (not part of `pnpm test`). Runs the real `llm` handler with a real Claude provider and the real Slack connector: Claude requests `send_slack_message`, the platform executes it, and the model finalizes. Prints only safe metadata (rounds, per-round token counts, final output); never the API key, auth token, or bot token. Reports "NOT executed" and exits cleanly if the Claude credential, encryption key, or connection is absent. |
| `pnpm typecheck`                                                            | Type-check the project and the tooling configs, without emitting.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pnpm test`                                                                 | Run the test suite once (`vitest run`).                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm build`                                                                | Compile TypeScript to `dist/` and rewrite `@/*` aliases to relative paths.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm start:api`                                                            | Run the compiled API from `dist/` (production mode).                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm start:worker`                                                         | Run the compiled worker from `dist/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Database commands

| Command                | What it does                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm db:generate`     | Diff `src/db/schema.ts` against `drizzle/` and write a new migration. **Needs no database.** |
| `pnpm db:migrate`      | Apply pending migrations. Idempotent.                                                        |
| `pnpm db:migrate:dist` | Same, from the compiled output — what a deploy runs before starting the API.                 |
| `pnpm db:check`        | Verify the migration files and snapshots are consistent with each other. No database needed. |
| `pnpm db:push`         | Sync the schema straight to the database without a migration. **Dev prototyping only.**      |
| `pnpm db:studio`       | Open Drizzle Studio to browse the data.                                                      |

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

## Local frontend

The visible application lives in [`frontend/`](frontend/), a separate Nuxt 3
single-page app. It consumes Fastify through a small typed client; it does not
duplicate API routes or contain backend business logic.

Start the API first, then in another terminal:

```bash
cd frontend
pnpm dev
```

Open `http://localhost:3001`. Create `frontend/.env` from
[`frontend/.env.example`](frontend/.env.example) and set `NUXT_PUBLIC_API_KEY`
to a local tenant API key. This is development-only browser configuration; never
commit a real key. The Nuxt Vite server proxies `/backend/*` to
`NUXT_BACKEND_URL` (default `http://127.0.0.1:3000`) so browser requests remain
same-origin and Fastify needs no CORS policy.

The current API exposes authenticated tenant-scoped collection reads for
workflows, runs, and connections, plus detailed run inspection by id. The Nuxt
dashboard consumes these endpoints directly through the typed frontend API client.

### Endpoints

| Method | Path                      | Auth       | Purpose                                                                                                                                                                    |
| ------ | ------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/healthz`                | none       | Process liveness. `200` while the event loop is turning — does not query the database.                                                                                       |
| `GET`  | `/readyz`                 | none       | Process readiness. `200` only when the database is reachable (`select 1`), `503` otherwise. Leaks no connection detail.                                                     |
| `POST` | `/v1/api-keys`            | Bearer key | Create a key for the caller's tenant. Returns the plaintext **once**.                                                                                                      |
| `GET`  | `/v1/api-keys`            | Bearer key | List the caller's own keys (metadata only — never the key).                                                                                                                |
| `POST` | `/v1/api-keys/:id/revoke` | Bearer key | Revoke one of the caller's keys. `204` on success, `404` if it is not theirs.                                                                                              |
| `POST` | `/v1/webhooks/:source`    | Bearer key | Ingest a webhook. Captures the event idempotently and, if `:source` has an active workflow, creates a queued run.                                                          |
| `GET`  | `/v1/workflows`           | Bearer key | List workflows for the caller's tenant, newest first, keyset-paginated (`createdAt DESC, id DESC`).                                                                        |
| `GET`  | `/v1/runs`                | Bearer key | List runs for the caller's tenant, newest first, keyset-paginated, with optional `status` and `workflowId` filters.                                                        |
| `GET`  | `/v1/connections`         | Bearer key | List non-secret connection metadata for the caller's tenant, newest first, keyset-paginated (`createdAt DESC, id DESC`).                                                   |
| `GET`  | `/v1/runs/:runId`         | Bearer key | Inspect one of the caller's own runs — the same safe, summarized view the CLI renders. `404` (identical shape) if the run does not exist **or** belongs to another tenant. |

#### Webhook ingestion (`POST /v1/webhooks/:source`)

The event is **always accepted**; only the routing outcome varies. Ingestion is
idempotent: the dedupe key is the caller's `X-Event-ID` header if present, else a
SHA-256 of the raw request body — a retried delivery never creates a second event
or run. The event and (when configured) its run are written in one transaction.

| Outcome                               | Status | Body                                                                         |
| ------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| New event, active workflow matched    | `202`  | `{ event_id, run_id, status: "queued" }`                                     |
| New event, no workflow for the source | `202`  | `{ event_id, run_id: null, status: "accepted", workflow: "not_configured" }` |
| Duplicate delivery                    | `200`  | `{ event_id, run_id, status: "duplicate" }`                                  |

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

> **HMAC signature verification is implemented and on by default for every configured
> source.** When the active workflow version for `(tenant, source)` carries a
> `signature` config block (see "Webhook signature verification" below), every
> delivery is verified — and failed verification is a hard `401` before any event
> is persisted, dedupe-key computed, or transaction started. Sources without a
> `signature` block continue to authenticate on the bearer key only; this is the
> legacy behaviour and exists so smoke-test sources and the `inspect-webhooks`
> CLI keep working. **Provider webhooks exposed to the internet must carry a
> `signature` block.**

#### Webhook signature verification

A signature is required for any provider webhook exposed to the internet. The
shared secret is stored once as a **Connection** (encrypted, tenant-scoped, can
be rotated independently of the workflow) and referenced by `secret_connection_id`
on the workflow's `webhook` trigger. The signature config is a discriminated
union on `signing_input`; the verifier does not negotiate.

| `signing_input`         | HMAC input bytes (exactly)                                       |
| ----------------------- | ---------------------------------------------------------------- |
| `raw_body`              | `rawBody`                                                        |
| `timestamp_and_body`    | `canonicalTimestamp || 0x2E || rawBody`                          |

- `rawBody` is the **exact** bytes captured by the JSON content-type parser
  before any parse, re-serialise, or trim. Re-serialising the parsed object
  will not produce the same bytes.
- `canonicalTimestamp` is the integer value of the timestamp header formatted
  as `String(n)` — the **single** form the verifier uses in the HMAC input.
  Leading zeros are stripped; surrounding whitespace is removed. A sender who
  signs the literal header text (with leading zeros or whitespace) will see
  their signature rejected as `signature_mismatch`.
- `0x2E` is a single literal `.` byte. **It is not configurable.** Adding a
  new scheme (e.g. a different separator) is a code change with a new
  `signing_input` mode, not a config knob, so an operator cannot author a
  signing config the verifier cannot justify.

##### `raw_body` mode

```
HMAC-SHA256(key=secret, msg=rawBody)
```

The signature header value, after `signature_prefix` is stripped (if configured),
is the HMAC encoded as `signature_encoding` (`hex` or `base64`). No timestamp,
no separator, no other bytes.

##### `timestamp_and_body` mode

```
HMAC-SHA256(key=secret, msg=canonicalTimestamp || 0x2E || rawBody)
```

- `canonicalTimestamp` is the integer value of the timestamp header,
  formatted as `String(n)` — the **single** form the verifier uses in the
  HMAC input. Leading zeros are stripped; surrounding whitespace is removed.
  A sender who signs the literal header text (with leading zeros or
  whitespace) will see their signature rejected as `signature_mismatch`
  because the verifier's canonical bytes differ.
- `0x2E` is a single literal `.` byte. **It is not configurable.** Adding a
  new scheme (e.g. a different separator) is a code change with a new
  `signing_input` mode, not a config knob, so an operator cannot author a
  signing config the verifier cannot justify.
- `tolerance_seconds` is the maximum difference (in seconds) between the
  parsed timestamp and the verifier's clock; bounded `1..3600` so a
  misconfiguration cannot quietly disable the check.
- The header is parsed as a non-negative decimal integer. `+`, `-`, `.`,
  hex prefixes, decimal points, and any other non-decimal shape are rejected
  as `timestamp_malformed` before the HMAC is computed.

###### What this mode guarantees, and what it does not

`timestamp_and_body` provides **three** properties:

1. **Authenticated timestamp.** The timestamp is part of the HMAC input. An
   attacker cannot substitute a fresh timestamp without invalidating the
   signature — the verifier's recomputed HMAC over `(attackerTs || . || body)`
   will not equal a captured signature that was computed over the original
   timestamp.
2. **Freshness / tolerance enforcement.** The parsed integer is checked
   against `tolerance_seconds` of the verifier's clock. Stale and
   far-future timestamps are rejected as `timestamp_out_of_tolerance`. This
   bounds the window in which an attacker could replay a captured delivery
   by adjusting timing alone (and even that is bounded because the timestamp
   is authenticated — see point 1).
3. **Replay-window protection.** A captured delivery cannot be replayed
   *outside* the configured tolerance window. Within the window, an
   exact-duplicate replay of the same `(timestamp, body, signature)` is
   **not** rejected by signature verification — suppression of such
   duplicates is the responsibility of the route's `X-Event-ID` dedupe layer,
   which is caller-controlled and is a known separate concern.

This mode does **not** provide universal one-time replay prevention on its
own. Operators who need strict one-time semantics should layer an
application-level nonce store on top.

##### Config schema (Zod, strict)

```ts
type SignatureConfig =
  | {
      signing_input: "raw_body";
      algorithm: "hmac-sha256";
      secret_connection_id: string;     // UUIDv7 — connection holding the shared secret
      signature_header: string;         // 1-64 [a-z0-9-]
      signature_encoding: "hex" | "base64";
      signature_prefix?: string;        // 1-64 printable ASCII, no whitespace
    }
  | {
      signing_input: "timestamp_and_body";
      algorithm: "hmac-sha256";
      secret_connection_id: string;
      signature_header: string;
      signature_encoding: "hex" | "base64";
      signature_prefix?: string;
      timestamp_header: string;         // 1-64 [a-z0-9-]
      tolerance_seconds: number;        // int, 1..3600
    }
```

Unknown fields are rejected at parse time (`.strict()`). The algorithm is locked
to `hmac-sha256`; there is no `none`/empty value and no per-request algorithm
override.

##### What gets logged

The verifier itself does not log. On a failed verification the route emits one
structured log line:

```json
{
  "level": "warn",
  "msg": "webhook signature verification refused",
  "source": "github",
  "reason": "signature_mismatch",
  "signing_input": "timestamp_and_body",
  "raw_body_length": 42
}
```

— `reason` is a stable code (`signature_header_missing`, `signature_malformed`,
`timestamp_header_missing`, `timestamp_malformed`, `timestamp_out_of_tolerance`,
`signature_mismatch`); `signing_input` records which mode was active; only
**lengths** of the inputs are recorded, never the body, signature, or secret.
The HTTP response is a single generic `401` regardless of reason so a caller
cannot probe by response text.

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

> `GET /v1/runs` is intentionally read-only and summary-focused. Mutation and
> cancellation actions remain out of scope for this phase.

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
cannot tell them apart. There is no way to authenticate to create your _first_
key, so the first one per tenant is minted out-of-band:

```bash
TENANT_ID=$(pnpm -s tenant:create "Acme Inc")
pnpm apikey:create "$TENANT_ID" "bootstrap"   # prints the plaintext once
```

A conservative in-memory rate limit (100 requests/minute per IP, proxy-aware via `TRUST_PROXY`) blunts
credential stuffing on a single instance. By default `TRUST_PROXY=false` (local/dev safe) the
limiter keys by the socket remote address and ignores `X-Forwarded-For`; when
deployed behind a trusted reverse proxy / PaaS the operator explicitly sets
`TRUST_PROXY=true` (or a list of trusted proxy CIDRs / `loopback`) so the
limiter keys by the forwarded client IP instead of the proxy's IP. It is
per-process and resets on restart; distributed, per-tenant rate limiting with a
shared store arrives later.

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
  **15-minute lease** on the row, checks the job's run still exists, and hands it to
  a dispatcher — logging `job_claimed`, then `job_completed`, `job_failed`, or
  `job_retry_scheduled` when a retryable step failure defers the job. The lease is
  not a round number picked by taste: [`src/domain/timing.ts`](src/domain/timing.ts)
  derives the worst case a legitimate step can take from the timeouts that actually
  bound it (5 tool rounds × (60 s Claude + 4 × 10 s Slack) + 60 s overhead ≈ 9 m 20 s)
  and keeps the lease a safety margin above it, so a step can never outlive the lease
  and have its job handed to a second worker. A unit test fails if any input drifts;
- a **reaper** that periodically returns jobs whose lease has expired to `pending`
  (incrementing `attempt`, **never** the business `retry_count`), so a job held by
  a crashed worker is never lost — logging `job_requeued` when it recovers any.
  That safety net is **bounded**: a job that has already been recovered
  `MAX_CRASH_ATTEMPTS` (5) times is _dead-lettered_ on its next expiry — moved to
  `failed` with `last_error.code = "crash_attempts_exhausted"`, never offered to a
  worker again, and logged once at error level as `job_dead_lettered` with its
  tenant, run, job, step and attempt. Without the ceiling, a job that _causes_ the
  crash (an OOM on a pathological payload, a wedged native dependency) would be
  handed to the next worker forever. Dead-lettering settles the **job** only: the
  run keeps whatever status it had, so it stays inspectable and run-state authority
  stays with the execution engine.

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

Stop it with `Ctrl+C`. It stops claiming first, then waits for any in-flight job for
at most `WORKER_SHUTDOWN_TIMEOUT_MS` (default 10 s) — logging
`worker_shutdown_requested` and `worker_shutdown_waiting`. If the job finishes in
time, its normal completion or failure handling stays authoritative. If the wait runs
out, the worker logs `worker_shutdown_timed_out` and hands the lease it still owns
back to the queue (`worker_lease_release_attempted` → `worker_lease_release_succeeded`,
or `worker_lease_release_skipped` when another worker has already taken the row), so
the job is `pending` and re-claimable at once instead of stranded for the rest of its
15-minute lease. The release is **not** a retry: `attempt`, `retry_count`,
`last_error` and `run_at` are all untouched. The job is never marked failed just
because shutdown ran out of patience.

What this does **not** do is cancel an in-flight Claude or Slack request — neither is
abortable from the shutdown path — so the step may still complete after the worker
has let go of it, and external side effects remain **at-least-once**. A late
settlement cannot corrupt the new owner: `complete`, `fail`, `retry` and `release`
all require the row to still be locked by the worker calling them, so a superseded
worker's write matches no row and is refused. Finally the reaper stops and the pool
closes; the process force-exits 5 s past the shutdown timeout if any of that hangs.

The two processes are independent — neither requires the other to run. Both
refuse to start if the database is unreachable, because a process that is
listening but cannot reach its database looks healthy to whatever is watching it.

### Operations: liveness, readiness, and worker observability

The two HTTP probes answer two different questions, and a load balancer / orchestrator
should treat them differently:

| Endpoint  | Question it answers             | Depends on the database? | When to act on failure                                                                                                                  |
| --------- | ------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `/healthz` | "Is the Node process alive?"    | No                       | Restart the process. A failing `/healthz` means the event loop is not turning — usually a crash or hang, never a transient DB blip.       |
| `/readyz`  | "Can this process serve traffic?" | Yes (`select 1`)         | Stop routing new traffic to this instance. A failing `/readyz` is expected during DB failover or pool exhaustion and recovers on its own. |

Both endpoints are public, unauthenticated, exempt from the rate limiter, and
inherit the four baseline security headers (`x-content-type-options`,
`x-frame-options`, `referrer-policy`, `permissions-policy`) from the root
`onSend` hook. Neither response includes the connection string, the host,
the error message, or any configuration — only the binary status, the
sub-check, and uptime. The real reason for a failed `/readyz` is logged
server-side (`request.log.warn({ err }, ...)`).

Worker process observability is in-memory and exposed through structured
logs only — no HTTP listener, no shared file, no Redis, no database table.
[`src/worker/heartbeat.ts`](src/worker/heartbeat.ts) tracks lifecycle state
(`starting` / `running` / `stopping` / `stopped`), the wall-clock and monotonic
timestamp of the most recent poll tick, the in-flight slot, and cumulative
settlement counters (`claimed`, `completed`, `failed`, `released`, `reaped`).
The worker process emits a `worker_heartbeat` summary log line every 30 s
with the same shape, so a log-shipping consumer can graph any field without
adapting to a different schema. The snapshot is redaction-free by
construction: no tenant id, run id, job id, step key, prompt, payload,
secret, or raw error ever enters it.

Stale detection is derived from existing timing rather than invented:
`STALE_HEARTBEAT_MS = max(3 * POLL_INTERVAL_MS, REAPER_INTERVAL_MS)` —
30 s. A worker that has missed one reaper sweep AND at least three poll
cycles is stale; the reaper itself would have detected stuck leases by
then, so the loop is clearly not healthy. This is an in-process notion
only — the API process has no view of it, by design (see below).

The three operational states an operator needs are visible at three
independent observability points, not collapsed into one:

1. **API ready** — `GET /readyz` returns 200 on the API process.
2. **Worker running** — the worker process exists, its logs show
   `worker_heartbeat` lines, and `heartbeat_state` is `running`.
3. **Worker stopped** — no `worker_heartbeat` lines for >30 s, or the
   process has exited and structured logs show `worker_shutdown` /
   `worker_stopped_cleanly`.

The API `/readyz` deliberately does NOT include a worker section: the
worker runs in a separate process, the API has no way to read its state,
and coupling API readiness to worker activity would make a healthy API
report "not ready" because the worker is down — which is a separate
operational signal that belongs at a separate observability point.

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

| Variable                     | Default         | Purpose                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`               | **required**    | PostgreSQL connection URL. Add `?sslmode=require` for hosted providers. In `production` must not point to `localhost`/`127.0.0.1`/`::1`/`::ffff:127.0.0.1` and database name (URL-decoded, case-insensitive) must not contain `test`.                                                                           |
| `TEST_DATABASE_URL`          | _(unset)_       | **Test-only.** PostgreSQL URL for the integration suite — never used at runtime. When set, must be valid and must not resolve to same database as `DATABASE_URL` (host/port/database compared semantically; user, password and `?sslmode` differences are ignored). Suite additionally requires database name to contain `test`. |
| `DATABASE_POOL_MAX`          | `10`            | Max pooled connections **per process**. Two processes run, so the real ceiling is roughly double.                                                                                                                                                                                                             |
| `NODE_ENV`                   | `development`   | `development` enables pretty logs; `production` emits JSON. `production` activates strict invariants (see `DATABASE_URL`, `HOST`, `ANTHROPIC_BASE_URL`).                                                                                                                                                     |
| `LOG_LEVEL`                  | `info`          | pino level: `fatal`…`trace`, or `silent`. `debug` also logs every SQL statement.                                                                                                                                                                                                                              |
| `HOST`                       | `127.0.0.1`     | API bind address. Use `0.0.0.0` in a container or on a PaaS. In `production` must not be `127.0.0.1`/`localhost`/`::1`/`::ffff:127.0.0.1` — set `0.0.0.0` (or other non-loopback) or startup is refused.                                                                                                          |
| `PORT`                       | `3000`          | API port.                                                                                                                                                                                                                                                                                                     |
| `TRUST_PROXY`                | `false`         | Whether `request.ip` (and the per-IP rate limiter) trusts `X-Forwarded-For`. `false` (default, safe for local/dev) ignores forwarding headers; `true` trusts the proxy (use only when behind a trusted PaaS/reverse proxy that is the sole ingress); a comma-separated list of proxy IPs/CIDRs or `loopback`/`linklocal`/`uniquelocal` trusts only those. Do not set `true` unless you are actually behind a trusted proxy. |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | `10000`         | How long graceful worker shutdown waits for an in-flight job before returning and, if it still owns the lease, releasing that job back to `pending`. This does **not** cancel the underlying external request.                                                                                                |
| `CREDENTIAL_ENCRYPTION_KEY`  | _(unset)_       | **Optional secret.** 256-bit master key for encrypting external-service credentials at rest (AES-256-GCM). Accepts 64 hex characters or a base64/base64url value decoding to exactly 32 bytes. **Backward-compatible single-key deployment:** when set, `connections:create` writes v1 envelopes and the key is also auto-imported as a single `legacy-v1` decrypt-only ring entry. Without this var (or a `legacy-v1` entry in `CREDENTIAL_ENCRYPTION_KEYS`), `connections:create` fails clearly at first encrypt with typed `legacy_v1_writer_missing`. Never logged, persisted, or returned to clients. |
| `ANTHROPIC_API_KEY`          | _(unset)_       | **Optional secret.** Direct-Anthropic credential, sent as `x-api-key`. Only needed by code paths that call Claude; the app boots without it. Never logged, persisted, or returned to clients. **Mutually exclusive** with `ANTHROPIC_AUTH_TOKEN`. If `ANTHROPIC_BASE_URL` is set, at least one of the two must be set.      |
| `ANTHROPIC_AUTH_TOKEN`       | _(unset)_       | **Optional secret.** Bearer token for an Anthropic-_compatible_ gateway, sent as `Authorization: Bearer …`. **Mutually exclusive** with `ANTHROPIC_API_KEY` — set exactly one; configuring both is refused at startup. If `ANTHROPIC_BASE_URL` is set, at least one must be set.                                              |
| `ANTHROPIC_BASE_URL`         | _(unset)_       | Optional. Points the provider at an Anthropic-compatible gateway instead of `https://api.anthropic.com`. Give the **origin only** (optionally with a base path); do **not** include `/v1` — the SDK appends `/v1/messages` itself, so a trailing `/v1` would produce `/v1/v1/messages` (rejected at startup). **Requires** a credential (`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`) when set; in `production` must be `https://` (http allowed only for local dev). |
| `ANTHROPIC_MODEL`            | `claude-opus-5` | The model the provider defaults to when a request names none. A deployment decision; any request may override it. Against a gateway, this must be a model id **that gateway accepts** — the default is not guaranteed to be valid there.                                                                      |
| `CREDENTIAL_ENCRYPTION_KEYS` | _(unset)_       | **Optional secret.** Multi-key keyring for credential encryption — comma-separated `<kid>:<base64key>` pairs. The **first** entry is the v2 active encrypt key; every subsequent entry is decrypt-only. Kid format: `^[a-zA-Z0-9._-]{1,64}$`; key bytes: 32 (same shape rule as `CREDENTIAL_ENCRYPTION_KEY`). The literal kid `legacy-v1` is reserved (always decrypt-only; can never be the first entry). When both this var and `CREDENTIAL_ENCRYPTION_KEY` are set, the keyring wins for decryption; the legacy var is honoured as the v1 writer only when the keyring itself lacks a `legacy-v1` entry. Required for `pnpm connections rotate` — the CLI fails fast with typed `active_key_missing` when no active entry is configured. Never logged. |

Two PostgreSQL **session guards** are always active, without any extra env var: `statement_timeout = 30s` (raised to `300s` only for the migration runner, `60s` in integration tests) caps any single query, and `idle_in_transaction_session_timeout = 30s` — per PostgreSQL docs, an idle-in-transaction session is terminated with `25P03` — limits how long a `BEGIN`…`COMMIT` may sit idle, reducing the window where a stuck `await` could hold row locks or bloat `pg_stat_activity`. Legitimate transactions are the short `beginStep`/`settleStep` and `claim`/`requeueExpired` bookkeeping the engine already runs outside handlers (the handler itself executes with no DB transaction held, per the two-transaction model), so `30s` is generous for normal work but tight enough to reclaim a leaked transaction. The values are centralized in [`src/db/client.ts`](src/db/client.ts) as `DEFAULT_*_TIMEOUT_MS` and applied in two layers: retained as `pg` startup parameters for direct/vanilla PostgreSQL where they are honored, and additionally via explicit session initialization (`SET`) on each new physical connection (`onConnect` hook, awaited before the connection is usable — `options=-c` is not used because Neon pooled endpoints reject it as unsupported). The integration test verifies the effective `SHOW` values against the configured `TEST_DATABASE_URL` (idle `30s`, `statement_timeout` `>0`, preserved inside `BEGIN`/`COMMIT` and after reacquire) without sleeping 30s to trigger the `25P03` abort.

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
  _Retryable_: abort/timeout, connection failure, `429`, and transient `408`/`5xx`.
  _Permanent_: bad key (`401`/`403`), invalid request (`400`/`422`), unknown model
  (`404`), a refusal `stop_reason`, and — crucially — any _unrecognised_ error, so
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
    "output_schema": {
      "type": "object",
      "properties": { "summary": { "type": "string" } },
      "required": ["summary"],
    },
    "tools": [{ "name": "send_slack_message", "connection_id": "<uuid>" }],
    "max_tool_rounds": 4,
  },
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
│   ├── job-queue.ts            PostgresJobQueue — enqueue/claim/complete/fail/retry/release/requeueExpired
│   └── execution-engine.ts     WorkflowExecutor — advances a run by one step, atomically
├── cli/                      create-tenant.ts, create-api-key.ts, create-workflow.ts, inspect-webhooks.ts, llm-smoke.ts, connections.ts, slack-smoke.ts, llm-tool-smoke.ts (bootstrap/dev)
├── worker/
│   ├── main.ts               Entrypoint 2 — composition root: worker + reaper wiring, shutdown
│   ├── worker.ts             The claim → verify → dispatch → settle loop
│   ├── reaper.ts             Periodic sweep: expired leases back to the queue, poison jobs dead-lettered
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
│   ├── timing.ts            Derived step-duration budget → job lease + shutdown timeout
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
  `PermanentError`. Unclassified errors are treated as _not_ retryable.
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

| Table                | Holds                                                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenants`            | One row per customer organisation                                | Root of every ownership chain. `suspended` stops execution without deleting history.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `users`              | A human, belonging to one tenant                                 | No auth material yet. Unique per tenant on `lower(email)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `workflows`          | The stable identity of a process                                 | Name, status. Holds no logic itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `workflow_versions`  | An immutable snapshot of the logic                               | `definition` jsonb, trigger config, version number.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `events`             | A raw external signal captured at the webhook boundary           | `source`, `dedupe_key`, `payload` jsonb, `received_at`. Idempotent per `(tenant_id, source, dedupe_key)`.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `workflow_runs`      | One execution of a workflow, born from an event                  | Pins `workflow_id` + `workflow_version_id` + `event_id`; `status` (starts `queued`), `context` jsonb. Advanced one step per job by the execution engine.                                                                                                                                                                                                                                                                                                                                                           |
| `jobs`               | A unit of durable work advancing a run's step                    | `step_key`, `attempt` (crash/lease recovery) / `retry_count` (business retries) / `max_attempts` (business budget), `status` (`pending`→`running`→`done`/`failed`), `run_at` (a retry's future defer lives here), `locked_by` + `lease_expires_at` (the lease), `last_error`. Claimed with `FOR UPDATE SKIP LOCKED`.                                                                                                                                                                                               |
| `workflow_step_runs` | One executed step of a run                                       | Records the step's `status`, `output` jsonb and error, one row per step the engine advances. Composite tenant-safe FK to its run.                                                                                                                                                                                                                                                                                                                                                                                  |
| `llm_usage`          | Token/latency accounting for one provider round of an `llm` step | `provider`, `model`, `round`, `input_tokens`/`output_tokens`/`total_tokens`, `latency_ms`. Written atomically with the step-run settle; `UNIQUE(step_run_id, round)`. A no-tools step meters one round; a tool-calling step meters one row per request→execute round. Metadata only — never the prompt, output or credential.                                                                                                                                                                                      |
| `api_keys`           | A tenant's bearer credentials                                    | Stores a SHA-256 `key_hash` and a short `prefix`, never the key. `revoked_at` disables one.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `connections`        | A tenant's authorization to act against an external provider     | `provider`, `name`, `status` (`active`/`disabled`/`error`), `encrypted_credentials` jsonb (a versioned AES-256-GCM envelope — never plaintext), non-secret `metadata`, `last_used_at`. `UNIQUE(tenant_id, id)` for future composite FKs and `UNIQUE(tenant_id, provider, name)` for distinct names. A tenant may hold **many active connections to the same provider** (e.g. two Slack workspaces); which one a tool uses is decided by a trusted `connectionId` in platform/workflow config — never by the model. |

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
scans settled work. The first job of a run is created inside the _same_
transaction as the event and the run, so there is never a queued run without a job
to advance it.

### Authentication and tenant isolation

Tenant isolation is enforced in the application layer by a `TenantScope`: a small
value that binds a database handle to exactly one tenant id. Repositories are
constructed _from_ a scope, never from a bare handle, so an instance is
intrinsically pinned to one tenant and its queries cannot omit the tenant
predicate. There are no generic "fetch across all tenants" helpers.

The one unavoidable exception — resolving _which_ tenant a presented API key
belongs to, before any tenant is known — is confined to a single narrow
`ApiKeyStore` used only by the authenticator, and named to make its exceptional
nature obvious. PostgreSQL Row-Level Security will later back this with a
database-enforced guarantee; until then this pattern is the boundary, and it is
proven end-to-end by the tenant-isolation tests. The authentication mechanism
itself sits behind a framework-free `Authenticator` seam that yields
`request.auth.tenantId`, so it can be swapped for sessions, OAuth or RBAC later
without touching route code.

Tenant isolation is verified by three complementary layers:

- **Per-domain integration suites** (`connections.test.ts`, `jobs.test.ts`,
  `api-keys.test.ts`, `workflows.test.ts`, `webhooks.test.ts`, `execution.test.ts`,
  `run-inspection.test.ts`) assert the per-repository view: each one proves its
  own tenant-scoped reads/writes are blind to other tenants.
- **A consolidated cross-tenant security suite** in
  `src/test/integration/tenant-isolation.test.ts` exercises every tenant-facing
  surface end-to-end against a real PostgreSQL across eight categories (A–H):
  API keys, workflows, runs, events/jobs, connections, webhook HMAC, execution,
  and a negative data-shape sweep that checks A's responses for any of B's
  distinguishing markers.
- **A static architecture test** in
  `src/test/unit/tenant-isolation-architecture.test.ts` reads every file in
  `src/repositories/` and enforces that every class operating on a tenant-scoped
  table either extends `TenantScopedRepository`, takes a `TenantScope`
  directly, or uses one of a small number of named alternative mechanisms
  (`PostgresJobQueue`'s optional `tenantId` option, `WorkflowExecutor`'s
  per-`ClaimedJob` tenant id, or the legacy auth-only `DrizzleApiKeyStore`). It
  fails the build when a future repository or service bypasses the scope, and
  its named allow-list makes the rationale for each exception explicit.

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
expired-lease job and increments its attempt while leaving live leases alone, that
a job at the crash-recovery ceiling is dead-lettered instead — recovered on its
last remaining attempt, condemned on the next expiry, then terminal (no later sweep
requeues it and no worker claims it) — with `retry_count` and `attempt` provably
independent in both directions, and that a tenant-scoped queue can neither claim,
mutate, nor dead-letter another tenant's jobs. For
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

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main`, on every pull request,
and on demand via _Run workflow_. It is two independent jobs, so a failure in one
never hides the other.

**`verify` (no database)** — `pnpm install --frozen-lockfile`, `pnpm typecheck`,
`pnpm db:check`, a schema-drift guard, then `pnpm build`. The drift guard runs
`pnpm db:generate` (which needs no database) and fails if anything under
`drizzle/` changed afterwards: on a healthy tree the generator prints _No schema
changes_ and writes nothing, so a new or modified file there means
`src/db/schema.ts` was edited without committing its migration. stdin is closed
for that step so a drizzle-kit rename prompt fails fast instead of hanging the
job.

**`test` (PostgreSQL 17)** — the same install, then `pnpm test` against a
`postgres:17` service container. This is the only place the integration suites
actually execute, because there is no local PostgreSQL in this development
environment. The container's database is named `ai_workforce_test` so it
satisfies the "name must contain `test`" guard in
`src/test/integration/support.ts`, and `TEST_DATABASE_URL` addresses it over
`127.0.0.1` rather than `localhost` — the published service port is on IPv4 and
`localhost` can resolve to `::1` first on a runner. `global-setup.ts` applies the
migrations once before the suites run.

Because `vitest run` exits 0 when every integration suite _skips_, the job
asserts `TEST_DATABASE_URL` is non-empty before running the tests. That variable
is the single gate every integration file reads, so an edit that drops it turns
CI red instead of quietly reducing the run to unit tests only.

CI needs **no secrets**. Every suite that touches credentials generates its own
key with `generateCredentialKey()`, and the Anthropic and Slack transports are
faked, so the checkout plus the PostgreSQL container is the whole environment.
The pnpm version comes from `packageManager` in `package.json` (the workflow
passes no version of its own) and the Node major matches `engines.node`, so CI
cannot drift from local development.

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
  - `GET /healthz` — process liveness, no DB dependency; `GET /readyz` —
    database readiness (`select 1`); neither leaks connection detail
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
  framework-free `Queue` contract (`enqueue`/`claim`/`complete`/`fail`/`retry`/
  `release`/`requeueExpired`) with a PostgreSQL implementation that claims one ready
  job at a time via `SELECT … FOR UPDATE SKIP LOCKED` in a short transaction, holds it
  under a 15-minute lease (`locked_by` + `lease_expires_at`) derived in
  [`src/domain/timing.ts`](src/domain/timing.ts) from the timeouts that actually bound
  a step, and rejects illegal state transitions (`done`/`failed` are terminal, and
  every settlement must come from the worker that still holds the lease). The worker
  stamps its instance id on every claim, verifies the run still exists, dispatches,
  and settles — with structured logs (`worker_started`, `job_claimed`,
  `job_completed`, `job_failed`, `job_requeued`, `worker_shutdown`) carrying
  `tenant_id`/`run_id`/`job_id`/`worker_id`. Shutdown is time-bounded and hands back
  the lease of anything still in flight (`WORKER_SHUTDOWN_TIMEOUT_MS`). A reaper
  returns expired-lease jobs to `pending` (incrementing `attempt`) with a single
  atomic UPDATE, safe across processes. The first job is created in the same
  transaction as the event and run. At this step **no step executed yet** — the
  dispatcher was a stub that refused every step and the worker recorded that as a
  terminal failure, never marking a job `done`; the real execution engine arrives in
  Step 6.
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

| Area                                                                                                                                    | Arrives in                                               |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Additional connectors (Gmail, GitHub, …), OAuth onboarding                                                                              | later steps / not scheduled                              |
| Run inspection endpoints and log redaction                                                                                              | Step 12                                                  |
| Distributed rate limiting, PostgreSQL RLS, CI                                                                                           | Step 13                                                  |
| Tool-execution idempotency ledger (exactly-once external effects)                                                                       | deferred — external effects are at-least-once until then |
| HMAC / provider signature verification on webhooks                                                                                      | before production webhooks                               |
| Agent loops, autonomous multi-step agents, MCP, RAG / embeddings, prompt caching, streaming, model training / fine-tuning, any frontend | not scheduled                                            |

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
