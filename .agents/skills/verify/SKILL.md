---
name: verify
description: Run the AI Workforce verification pipeline after a code or schema change — db:generate/check, typecheck, test, build — and report pass/fail concisely.
---

# Verify

Run the project's full verification pipeline and report the result. Use this after
any code or schema change, and always before reporting a build step complete.

## Order (stop and report on the first failure)

1. **Migrations** — only if `src/db/schema.ts` changed this session:
   ```bash
   pnpm db:generate
   ```
   Then confirm consistency:
   ```bash
   pnpm db:check
   ```
   `db:generate` writes a new file under `drizzle/` and needs no database. Never use
   `pnpm db:push` to author migrations.

2. **Typecheck**:
   ```bash
   pnpm typecheck
   ```

3. **Tests**:
   ```bash
   pnpm test
   ```
   Integration tests SKIP unless `TEST_DATABASE_URL` points at a DB whose name
   contains `test`. Skipped ≠ passed — say so explicitly if they skipped.

4. **Build**:
   ```bash
   pnpm build
   ```

## Reporting
Report each stage's outcome in one line (pass / fail + counts). If tests skipped for
lack of a database, state which suites were not actually exercised. On failure, show
the relevant output and fix the root cause before re-running — do not paper over it.
Do not run any git commands.
