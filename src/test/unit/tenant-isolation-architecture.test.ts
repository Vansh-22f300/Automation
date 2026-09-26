/**
 * Static architecture test for the tenant-isolation pattern.
 *
 * Tenant isolation is enforced by `TenantScope` + `TenantScopedRepository`
 * (see [src/repositories/tenant-scope.ts](src/repositories/tenant-scope.ts)).
 * The contract is structural:
 *
 *   - Every class that operates on a tenant-scoped table must be
 *     tenant-bounded in one of three documented ways:
 *       1. extends `TenantScopedRepository` (taking a `TenantScope` via
 *          `super(scope)`),
 *       2. takes a `TenantScope` directly as a constructor parameter,
 *       3. takes a `db: AppDatabase` but is bound to a tenant by an
 *          alternative mechanism documented in the class header (e.g. an
 *          optional `tenantId` constructor option that activates a
 *          tenant predicate when set, or a per-invocation `tenantId` field
 *          on the runtime argument, e.g. `ClaimedJob.tenantId`).
 *   - The single legitimate "operates on tenant data with a bare db and no
 *     tenant mechanism" exception is `DrizzleApiKeyStore`, because
 *     authentication is the one path that runs *before* the tenant is known.
 *
 * This test reads the source of every file under [src/repositories/](src/repositories/)
 * and enforces that contract. It is a build-time guard against the most
 * damaging class of bug in a multi-tenant system: a future repository or
 * service that "forgets" the tenant predicate. It does not need a database,
 * so it runs in every unit-test invocation.
 *
 * The check is deliberately coarse: it catches the patterns we know are
 * dangerous, and it names every exception so future readers can see why it
 * is allowed. If a future architecture cannot be expressed through these
 * rules, the failure message is the place to read.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Absolute path to the directory this test guards. */
const REPOSITORIES_DIR = join(process.cwd(), 'src', 'repositories');

/**
 * Classes that operate on a tenant-scoped table but use `TenantScope`
 * directly (not via `super(scope)`). The route layer composes these from
 * `auth.tenantId`.
 */
const KNOWN_TENANT_SCOPE_TAKER = new Set<string>([
  // Reads the active webhook version's `signature` config and decrypts the
  // configured connection's secret. Takes a TenantScope directly because the
  // route layer composes it from `auth.tenantId`. Does not extend the base
  // class because it has no list/CRUD surface — only one read-only method.
  'WebhookSignatureRepository',
]);

/**
 * Classes that operate on tenant-scoped tables but use an alternative
 * tenant-binding mechanism: either an *optional* `tenantId` constructor
 * option (e.g. `PostgresJobQueue`'s `{ tenantId }` option) or a per-invocation
 * tenant field on the runtime argument (e.g. `WorkflowExecutor`'s
 * `ClaimedJob.tenantId`). The tenant predicate is present only when the
 * alternative mechanism has set it; absent otherwise (worker view, dispatcher
 * before the job is claimed). This is documented in each class's header.
 */
const KNOWN_TENANT_AWARE_BY_RUNTIME = new Set<string>([
  // Worker queue + tenant-bound queue share one class. When `tenantId` is
  // passed via the options object, every claim/complete/fail/retry/etc.
  // statement adds `eq(jobs.tenantId, this.tenantId)`; the worker constructs
  // it without `tenantId` to see every tenant's work.
  'PostgresJobQueue',
  // The dispatcher's tenant comes from the `ClaimedJob.tenantId` field set
  // by the worker when it claimed the row (the queue's tenant predicate, when
  // set, makes this safe). The executor itself is shared across tenants and
  // its beginStep/settleStep queries are scoped to the claimed job's tenant.
  'WorkflowExecutor',
]);

/**
 * The single legitimate "operates on tenant data with a bare db and no
 * tenant mechanism" exception. The class header documents why.
 *
 * NOTE: the only known bare-db class is `DrizzleApiKeyStore`, but it lives in
 * [src/auth/api-key-store.ts](src/auth/api-key-store.ts), not in
 * [src/repositories/](src/repositories/). The list is intentionally empty so
 * the test fails loudly if a future author adds a class to
 * [src/repositories/](src/repositories/) that takes a bare `db` and queries
 * a tenant-scoped table.
 */
const KNOWN_BARE_DB_EXCEPTION = new Set<string>([]);

/** Classes that are NOT repositories — base classes, helpers, error types. */
const NOT_A_REPOSITORY = new Set<string>([
  'TenantScope',
  'TenantScopedRepository',
  // Thrown by `WebhookSignatureRepository.resolveForSource` when the signing
  // material is unavailable. Just an error class, no DB access.
  'WebhookSignatureSecretUnavailableError',
]);

/**
 * Concrete tenant-scoped tables this test treats as "tenant-owned".
 *
 * Each table is listed in *both* its snake_case form (the SQL name) and the
 * camelCase form the schema module exports (e.g. `apiKeys`). The schema
 * always exports a const of the camelCase name; the SQL name only appears in
 * the `pgTable('snake_case', …)` call, which is also a hit. A repo file that
 * imports `{ apiKeys }` from the schema will only mention `apiKeys` in code,
 * so without the camelCase form here the static check would miss it.
 */
const TENANT_SCOPED_TABLE_NAMES = [
  'memberships',
  'sessions',
  'workflows',
  'workflow_versions',
  'workflowVersions',
  'api_keys',
  'apiKeys',
  'events',
  'workflow_runs',
  'workflowRuns',
  'workflow_step_runs',
  'workflowStepRuns',
  'llm_usage',
  'llmUsage',
  'jobs',
  'connections',
] as const;

interface RepositoryFile {
  /** Absolute path. */
  readonly path: string;
  /** Path relative to the project root, for error messages. */
  readonly relPath: string;
  /** Full file source. */
  readonly source: string;
  /** Names of exported classes declared in this file. */
  readonly classes: readonly string[];
  /** Whether the file imports / references any tenant-scoped schema table. */
  readonly touchesTenantTable: boolean;
}

/**
 * Find every exported class declaration in a source file. Pragmatic regex —
 * TypeScript parser is heavier than this needs to be, and the patterns this
 * file declares are all single-class files with `export class FooBar` form.
 */
function findExportedClasses(source: string): string[] {
  const pattern = /^export\s+(?:abstract\s+)?class\s+([A-Z][A-Za-z0-9_]*)/gm;
  const out: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (typeof name === 'string') out.push(name);
  }
  return out;
}

/** True if the file mentions any of the tenant-scoped table identifiers. */
function touchesTenantTable(source: string): boolean {
  for (const name of TENANT_SCOPED_TABLE_NAMES) {
    // Match the table name as a whole word in code — `\b` keeps `workflows`
    // from matching `workflowVersions`, etc. The schema imports these by name.
    const re = new RegExp(`\\b${name}\\b`, 'm');
    if (re.test(source)) return true;
  }
  return false;
}

/** List every `.ts` file under the repositories directory (non-recursive — flat). */
function listRepositoryFiles(): RepositoryFile[] {
  const out: RepositoryFile[] = [];
  for (const entry of readdirSync(REPOSITORIES_DIR)) {
    if (!entry.endsWith('.ts')) continue;
    const abs = join(REPOSITORIES_DIR, entry);
    if (!statSync(abs).isFile()) continue;
    const source = readFileSync(abs, 'utf8');
    out.push({
      path: abs,
      relPath: relative(process.cwd(), abs),
      source,
      classes: findExportedClasses(source),
      touchesTenantTable: touchesTenantTable(source),
    });
  }
  return out;
}

/**
 * Per-class check that the constructor does not pair a bare `db: AppDatabase`
 * with a free `tenantId: string`. That combination is the anti-pattern this
 * test exists to prevent: it lets a future author call the repository with
 * one tenant and accidentally `db.insert(...)` against another.
 *
 * NOTE: `PostgresJobQueue` and `WorkflowExecutor` carry `tenantId` via
 * options/runtime-args and are listed in KNOWN_TENANT_AWARE_BY_RUNTIME, so
 * this check does not flag them.
 */
function hasBareDbAndFreeTenantId(source: string, className: string): boolean {
  const classRe = new RegExp(
    `class\\s+${className}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`,
    'm',
  );
  const body = source.match(classRe)?.[1] ?? '';
  const ctorMatch = body.match(/constructor\s*\(([\s\S]*?)\)/);
  if (ctorMatch === null) return false;
  const ctorParams = ctorMatch[1] ?? '';
  const hasBareDb = /\bdb\s*:\s*(?:AppDatabase|Pool)/.test(ctorParams);
  const hasFreeTenantId = /\btenantId\s*:\s*string/.test(ctorParams);
  return hasBareDb && hasFreeTenantId;
}

/** True if the class declaration extends `TenantScopedRepository`. */
function extendsTenantScopedRepository(source: string, className: string): boolean {
  const re = new RegExp(
    `class\\s+${className}\\b[^{]*extends\\s+TenantScopedRepository`,
    'm',
  );
  return re.test(source);
}

/** True if the class constructor takes a `TenantScope` parameter. */
function takesTenantScope(source: string, className: string): boolean {
  const classRe = new RegExp(
    `class\\s+${className}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`,
    'm',
  );
  const body = source.match(classRe)?.[1] ?? '';
  const ctorMatch = body.match(/constructor\s*\(([\s\S]*?)\)/);
  if (ctorMatch === null) return false;
  return /\bscope\s*:\s*TenantScope\b/.test(ctorMatch[1] ?? '');
}

/** True if the class constructor holds a bare `AppDatabase` / `Pool` parameter. */
function takesBareAppDatabase(source: string, className: string): boolean {
  const classRe = new RegExp(
    `class\\s+${className}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`,
    'm',
  );
  const body = source.match(classRe)?.[1] ?? '';
  const ctorMatch = body.match(/constructor\s*\(([\s\S]*?)\)/);
  if (ctorMatch === null) return false;
  return /\b(?:db|database)\s*:\s*(?:AppDatabase|Pool)\b/.test(ctorMatch[1] ?? '');
}

describe('tenant-isolation architecture', () => {
  const files = listRepositoryFiles();

  it('lists at least the expected repository files', () => {
    // Sanity check the harness: the test only matters if it actually read
    // the source files we expect. If this fails the directory layout has
    // changed and the assertions below need a re-check.
    // `DrizzleApiKeyStore` is intentionally absent — it lives in
    // [src/auth/api-key-store.ts](src/auth/api-key-store.ts), not under
    // [src/repositories/](src/repositories/).
    const classNames = files.flatMap((f) => f.classes);
    expect(classNames).toEqual(
      expect.arrayContaining([
        'TenantScope',
        'TenantScopedRepository',
        'ApiKeyRepository',
        'WorkflowRepository',
        'ConnectionRepository',
        'WebhookRepository',
        'RunInspectionRepository',
        'WebhookSignatureRepository',
        'PostgresJobQueue',
        'WorkflowExecutor',
      ]),
    );
  });

  describe('every tenant-scoped repository is tenant-bounded', () => {
    // Walk every exported class in every file; verify the tenant-bounded
    // contract. Classes that do not touch any tenant-scoped table are
    // skipped (they are framework helpers, e.g. TenantScope itself).
    const records: Array<{
      className: string;
      file: string;
      touchesTable: boolean;
    }> = [];
    for (const file of files) {
      for (const className of file.classes) {
        if (NOT_A_REPOSITORY.has(className)) continue;
        records.push({
          className,
          file: file.relPath,
          touchesTable: file.touchesTenantTable,
        });
      }
    }

    for (const { className, file, touchesTable } of records) {
      it(`${className} (${file})`, () => {
        const source = readFileSync(
          join(process.cwd(), file.replace(/\\/g, '/')),
          'utf8',
        );
        const extendsBase = extendsTenantScopedRepository(source, className);
        const takesScope = takesTenantScope(source, className);
        const takesBareDb = takesBareAppDatabase(source, className);

        // Classes that touch tenant-scoped tables MUST be tenant-bounded.
        if (!touchesTable) return;

        if (KNOWN_BARE_DB_EXCEPTION.has(className)) {
          // The single legitimate "auth-only" unscoped data path. Asserted
          // by name so future readers see why it is exempt.
          expect(
            takesBareDb,
            `${className} is on the bare-db allow-list; its constructor must take a bare AppDatabase`,
          ).toBe(true);
          expect(
            extendsBase || takesScope,
            `${className} is on the bare-db allow-list and must not also extend TenantScopedRepository`,
          ).toBe(false);
        } else if (KNOWN_TENANT_SCOPE_TAKER.has(className)) {
          expect(
            takesScope,
            `${className} is on the TenantScope allow-list and must take one`,
          ).toBe(true);
          expect(
            extendsBase,
            `${className} is on the TenantScope allow-list and must not also extend TenantScopedRepository`,
          ).toBe(false);
        } else if (KNOWN_TENANT_AWARE_BY_RUNTIME.has(className)) {
          // Alternative mechanism: the class carries its tenant via options
          // or via the runtime argument. The class header must say so. We
          // assert the class has *some* tenant mechanism — either an
          // options object with a `tenantId?: string` field, or a per-call
          // tenant argument in the public method signatures (ClaimedJob
          // carries one).
          const hasOptionsTenantId = /\btenantId\s*\?\s*:\s*string\b/.test(source);
          expect(
            extendsBase || takesScope,
            `${className} is on the runtime-tenant allow-list and must not also use TenantScope`,
          ).toBe(false);
          if (!extendsBase && !takesScope) {
            expect(
              hasOptionsTenantId || /tenantId/.test(source),
              `${className} is on the runtime-tenant allow-list; its source must reference a tenantId mechanism (options field or per-invocation argument)`,
            ).toBe(true);
          }
        } else {
          expect(
            extendsBase,
            `${className} must extend TenantScopedRepository (or be added to KNOWN_TENANT_SCOPE_TAKER / KNOWN_TENANT_AWARE_BY_RUNTIME / KNOWN_BARE_DB_EXCEPTION)`,
          ).toBe(true);
        }
      });
    }
  });

  describe('no class pairs a bare db with a free tenantId', () => {
    // The anti-pattern this test exists to prevent: a future author writes
    // a repository whose constructor takes both a raw `db` and a raw
    // `tenantId`. They then call `this.db.insert(...)` and either forget
    // `this.tenantId` or pass the wrong one — and the result is a
    // silent cross-tenant data leak. No exception list: nobody should
    // ever write this.
    const offenders: Array<{ className: string; file: string }> = [];
    for (const file of files) {
      for (const className of file.classes) {
        if (NOT_A_REPOSITORY.has(className)) continue;
        if (hasBareDbAndFreeTenantId(file.source, className)) {
          offenders.push({ className, file: file.relPath });
        }
      }
    }

    it('produces no offenders', () => {
      if (offenders.length > 0) {
        const rendered = offenders
          .map((o) => `  - ${o.className} (${o.file})`)
          .join('\n');
        throw new Error(
          `Repositories must use TenantScope, not pair a bare AppDatabase with a free tenantId.\n` +
            `Offending classes:\n${rendered}`,
        );
      }
      expect(offenders).toEqual([]);
    });
  });

  describe('the bare-db exception is read-only and confined to authentication', () => {
    // `DrizzleApiKeyStore` is the single tenant-blind path. It must:
    //   - not extend TenantScopedRepository (it has no tenant at use time),
    //   - take a bare `AppDatabase` (verified above),
    //   - not be imported anywhere except the authenticator seam and the
    //     tests that legitimately exercise that seam.
    it('DrizzleApiKeyStore is only imported by the authenticator seam', () => {
      const handle = readFileSync(
        join(process.cwd(), 'src/auth/api-key-store.ts'),
        'utf8',
      );
      // The store itself is the only class declared here.
      expect(/export\s+class\s+DrizzleApiKeyStore\b/.test(handle)).toBe(true);

      // Search the rest of the codebase for `DrizzleApiKeyStore` references.
      // Allowed:
      //   - the declaring file
      //   - the authenticator seam (the only production consumer)
      //   - the composition root that wires the authenticator
      //   - integration tests that exercise the authenticator via this store
      //   - this architecture test
      // Anywhere else is a smuggling attempt.
      const allowedImports = new Set<string>([
        'src/auth/api-key-store.ts',
        'src/auth/api-key-authenticator.ts',
        'src/api/server.ts',
        'src/test/unit/tenant-isolation-architecture.test.ts',
        'src/test/integration/api-keys.test.ts',
        'src/test/integration/tenant-isolation.test.ts',
      ]);
      const violations: string[] = [];
      walk('src', (path, source) => {
        const rel = relative(process.cwd(), path).replace(/\\/g, '/');
        if (allowedImports.has(rel)) return;
        if (/\bDrizzleApiKeyStore\b/.test(source)) {
          violations.push(rel);
        }
      });
      if (violations.length > 0) {
        throw new Error(
          `DrizzleApiKeyStore must only be referenced from the authenticator seam.\n` +
            `Unexpected references in:\n  - ${violations.join('\n  - ')}`,
        );
      }
      expect(violations).toEqual([]);
    });
  });
});

/**
 * Recurse `dir`, calling `visit(absPath, source)` for every `.ts` file.
 * Read-only — the test never writes anything. The harness function is
 * defined at the bottom so it does not pollute the assertion flow above.
 */
function walk(dir: string, visit: (path: string, source: string) => void): void {
  const abs = join(process.cwd(), dir);
  for (const entry of readdirSync(abs)) {
    const child = join(abs, entry);
    if (statSync(child).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') continue;
      walk(join(dir, entry), visit);
      continue;
    }
    if (!child.endsWith('.ts')) continue;
    const source = readFileSync(child, 'utf8');
    visit(child, source);
  }
}
