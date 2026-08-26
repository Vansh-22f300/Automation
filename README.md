# AI Workforce

AI-powered operations automation. Business applications are connected, a process
is described, and the platform executes it — receiving triggers, reasoning with
an LLM, calling external tools, and keeping a durable audit trail of every step.

> **Status: Step 1 of 13 — runnable foundation.**
> This repository currently contains a skeleton only. There is no database, no
> HTTP route, no workflow engine, and no AI integration yet. See
> [Current status](#current-status) for exactly what does and does not exist.

---

## Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | **>= 24.0.0, < 25** | Pinned via `engines`. Verified on v24.16.0. |
| pnpm | **>= 10** | Verified on 11.4.0. `npm install -g pnpm` if missing. |

Nothing else. No Docker, no database, no Redis, no API keys — this step has zero
external dependencies at runtime.

## Installation

```bash
pnpm install
```

Optionally create a local config file. Every variable has a default, so this is
not required:

```bash
cp .env.example .env
```

## Available commands

| Command | What it does |
| --- | --- |
| `pnpm dev:api` | Run the API in watch mode (`tsx`), restarting on file changes. |
| `pnpm dev:worker` | Run the worker in watch mode. |
| `pnpm typecheck` | Type-check the whole project without emitting output. |
| `pnpm test` | Run the unit test suite once (`vitest run`). |
| `pnpm build` | Compile TypeScript to `dist/` and rewrite `@/*` aliases to relative paths. |
| `pnpm start:api` | Run the compiled API from `dist/` (production mode). |
| `pnpm start:worker` | Run the compiled worker from `dist/`. |

## Starting the API

```bash
pnpm dev:api
```

It binds to `HOST:PORT` (default `127.0.0.1:3000`) and logs a line confirming it
is listening. **No routes are registered yet**, so any request returns Fastify's
default 404 — which is itself confirmation the server is serving:

```bash
curl -i http://127.0.0.1:3000/
```

Stop it with `Ctrl+C`; it logs `api stopped cleanly` on the way out.

## Starting the worker

```bash
pnpm dev:worker
```

It logs `worker started`, then emits a `worker tick` heartbeat roughly once per
second. This is a placeholder for the real job-claim loop (Step 5). Stop it with
`Ctrl+C`; it logs `worker stopped cleanly`.

The two processes are independent — neither requires the other to run.

## Configuration

Environment variables are validated at startup by
[`src/config/env.ts`](src/config/env.ts) using Zod. If anything is invalid the
process prints the offending variables and **exits with code 1** rather than
starting in a half-configured state:

```
FATAL: configuration error — refusing to start.

  PORT: Too big: expected number to be <=65535

  See .env.example for the expected values.
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` enables pretty logs; `production` emits JSON. |
| `LOG_LEVEL` | `info` | pino level: `fatal`…`trace`, or `silent`. |
| `HOST` | `127.0.0.1` | API bind address. Use `0.0.0.0` in a container or on a PaaS. |
| `PORT` | `3000` | API port. |

Variables are added only when code actually consumes them. `DATABASE_URL`,
`ANTHROPIC_API_KEY` and the credential encryption key arrive with the steps that
need them.

## Project layout

```
src/
├── api/server.ts             Entrypoint 1 — Fastify server
├── worker/main.ts            Entrypoint 2 — background worker loop
├── config/env.ts             Zod-validated, fail-fast environment config
├── observability/logger.ts   pino structured logging + correlation-ID helper
├── domain/errors.ts          RetryableError / PermanentError taxonomy
└── test/unit/                Unit tests
```

One codebase, two deployable processes. They share all domain code by direct
import, and are separate processes because they fail and scale differently — a
slow LLM call must never block webhook ingestion.

Directories for future concerns (`engine/`, `queue/`, `llm/`, `connectors/`,
`db/`, `security/`) are deliberately **not** created yet; they appear when they
hold real code rather than placeholder files.

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
- **Errors are classified where they are raised** as either `RetryableError` or
  `PermanentError`. Unclassified errors are treated as *not* retryable.

## Current status

### Implemented (Step 1)

- pnpm + ESM + strict TypeScript project setup, Node 24 pinned
- Fail-fast, Zod-validated environment configuration
- Structured pino logging with a `withContext` helper for `tenant_id`,
  `run_id`, `step_run_id`
- Fastify server that boots and shuts down cleanly on `SIGTERM`/`SIGINT`
- Worker process with a heartbeat loop and clean shutdown
- `RetryableError` / `PermanentError` taxonomy
- Unit tests for configuration validation and the error taxonomy
- Build pipeline producing runnable output in `dist/`

### Not implemented yet — intentionally

Nothing below exists in any form. It is sequenced, not forgotten.

| Area | Arrives in |
| --- | --- |
| PostgreSQL schema, Drizzle migrations, DB client | Step 2 |
| API-key authentication, tenant resolution, `/healthz` | Step 3 |
| Webhook ingestion, event persistence, idempotency | Step 4 |
| Job queue (`FOR UPDATE SKIP LOCKED`), worker claim loop, lease reaper | Step 5 |
| Workflow definition schema and the step executor | Step 6 |
| Claude integration behind an `LlmProvider` interface | Steps 7–8 |
| Connectors, credential encryption, first integration (Slack) | Steps 9–10 |
| Retry policy and backoff | Step 11 |
| Run inspection endpoints and log redaction | Step 12 |
| Isolation tests, rate limiting, CI | Step 13 |

Explicitly out of scope for the MVP entirely: OAuth flows, billing, a visual
workflow builder, Redis/Kafka, Kubernetes, microservices, vector stores or agent
memory, and any model training or fine-tuning.
