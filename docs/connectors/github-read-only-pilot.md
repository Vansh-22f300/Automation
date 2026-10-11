# GitHub read-only pilot — operator authoring

`github:prepare-pilot` is an **operator-only** CLI that authors the first GitHub pilot
workflow: a single `llm` step that may call **only** `github_get_authenticated_user`
(`GET /user`) against one tenant-owned GitHub connection. It exists so the production
pilot is authored through the validated `WorkflowRepository`, never ad-hoc SQL.

```bash
pnpm github:prepare-pilot <tenantId> <connectionId> [--commit]
```

- Both ids must be UUIDs; they are validated before any database access.
- The connection is verified **by metadata only** (tenant-scoped `getMetadata` — the
  credential is never decrypted): it must exist in the tenant, be `provider=github`, and
  be `active`. A wrong-tenant id reads as "not found".
- The authored step binds **only** the read tool. `github_create_issue` is never written
  into the definition, so the pilot step cannot offer a repository-writing tool.
- Fixed `system` prompt, a minimal `{ login: string }` output schema, `max_tool_rounds: 2`,
  `max_output_tokens: 256`.
- Run it in the **same environment as the worker/API** (it builds `ConnectionRepository`,
  which needs the credential-encryption key present — it does not decrypt).

## Default is a dry run; `--commit` is required to write

Without `--commit` the command validates, prints the exact plan, and **writes nothing**.
Re-run with `--commit` to create the workflow. The created workflow's version 1 is
**ACTIVE** (so a run can later be enqueued) — but **authoring enqueues no run**. The fixed
name `github-read-only-pilot` is used to **refuse creating a second pilot** in the tenant.

Secrets, tokens, and key material are never printed — only ids and non-secret connection
metadata (provider/status/login name).

## Two-stage operator procedure

**Stage 1 — prepare (this CLI).** Dry-run first, review the plan, then `--commit`:

```bash
pnpm github:prepare-pilot <tenantId> <connectionId>            # dry run — review
pnpm github:prepare-pilot <tenantId> <connectionId> --commit   # create ACTIVE workflow
```

This creates the workflow only. Nothing runs yet.

**Stage 2 — enqueue one run (separate, separately approved).** Do NOT bundle this with
Stage 1. With explicit approval, enqueue exactly one webhook event for source
`github-read-only-pilot` for the tenant (the normal ingest path), which creates one run +
one job.

### The scheduled worker may run the job before any manual dispatch

Once Stage 2 enqueues a job, the **scheduled `worker-free` cron may claim and execute it
at its next tick, before you manually `workflow_dispatch`** a worker session. Enqueuing is
therefore the point of no return for "a run will happen" — treat Stage 2 as the live
action and run it only when you are ready for the pilot to execute. (To execute promptly
and watch it, trigger `worker-free` via `workflow_dispatch` right after enqueuing;
cadence is otherwise best-effort and the scheduled worker drops most `*/5` ticks.)

## `max_tool_rounds` does NOT guarantee exactly one GitHub request

`max_tool_rounds: 2` bounds the number of model→tool **rounds** the `llm` step runs — it
does **not** cap the number of tool calls the model may request **within a single round**.
The step handler executes every tool call the model emits in a round. So the pilot does
**not** guarantee exactly one `GET /user`: a well-behaved model calls it once, but the
code does not enforce a single call, and the model could request it more than once (within
a round, or once per round across both rounds).

This is acceptable for the pilot because `github_get_authenticated_user` is a **read**
(`GET /user`): it is idempotent and effect-safe, each distinct call is reserved under its
own effect-ledger ordinal, and repeat reads have no side effects. If a strict single-call
guarantee is ever required, it must be enforced in code (e.g. a one-call-per-step cap),
not assumed from `max_tool_rounds`.

## What this does not do

- It does not enqueue, trigger, or execute a run; it makes no real GitHub or LLM call.
- It does not create issues, send Slack messages, rotate credentials, or decrypt anything.
- It does not register tools or change the worker — tool execution still happens in the
  worker via the per-step allowlist, which here contains only the read tool.
