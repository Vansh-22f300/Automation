---
name: next-step
description: Execute one step of the AI Workforce 13-step build order end to end — scope, implement, verify, document — then STOP without git or advancing.
---

# Next build step

Implement exactly ONE step of the fixed 13-step build order, then pause for review.
This encodes the standing workflow so it need not be re-explained each time.

## 1. Orient
- Read the `build-order-status.md` Codex memory to confirm which step is current and
  the binding decisions. Read `AGENTS.md` conventions if not already in context.
- Restate the step's scope in one or two sentences and confirm it against the
  **boundary list** — anything belonging to a later step is out of scope now.

## 2. Implement
- Change only what this step requires. Match existing conventions (ESM `.js` imports,
  `@/*` alias, UUIDv7 `primaryId()`, `TenantScope`, composite tenant-safe FKs,
  framework-free domain seams, `PermanentError`/`RetryableError`, `withContext` logs).
- Schema changes go in `src/db/schema.ts`; generate the migration with
  `pnpm db:generate` (never `db:push`).
- Keep domain logic pure and unit-testable; repositories own persistence; the worker
  orchestrates. Do not log secrets.

## 3. Test
- Unit tests for pure logic (no DB). Integration tests for real-Postgres behaviour,
  gated on `TEST_DATABASE_URL`, refusing any DB whose name lacks `test`; never fake a
  skipped integration test as passing.

## 4. Verify
- Run the `verify` skill (db:generate/check → typecheck → test → build). Fix root
  causes, not symptoms. Note explicitly if integration suites only skipped.

## 5. Document & report
- Update `README.md` status/sections and the `build-order-status.md` memory (+ the
  `MEMORY.md` index line) for the completed step.
- Give a concise report of what changed and how it was verified.

## 6. STOP
- **No git operations** (no commit/push/branch/PR/merge) unless the user explicitly
  asks in that message.
- **Do not** start the next step. Wait for review.
