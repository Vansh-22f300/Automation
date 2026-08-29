/**
 * Structural tests for the database schema.
 *
 * These run without PostgreSQL. Drizzle's `getTableConfig` exposes the model it
 * will emit DDL from, so the architectural invariants can be asserted directly
 * against the schema definition instead of against a live server.
 *
 * They are not a substitute for applying the migration — see
 * src/test/integration — but they are what stops a silent, easy-to-miss
 * regression: a dropped tenant_id, a naive timestamp, a lost unique constraint,
 * or an `updated_at` appearing on a table that is supposed to be immutable.
 */

import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  apiKeys,
  events,
  tenantStatus,
  tenants,
  triggerType,
  userStatus,
  users,
  workflowRunStatus,
  workflowRuns,
  workflowStatus,
  workflowVersions,
  workflows,
} from '@/db/schema.js';

type Column = ReturnType<typeof getTableConfig>['columns'][number];

function columns(table: PgTable): Map<string, Column> {
  return new Map(getTableConfig(table).columns.map((column) => [column.name, column]));
}

function column(table: PgTable, name: string): Column {
  const found = columns(table).get(name);
  if (found === undefined) throw new Error(`column "${name}" not found`);
  return found;
}

/** Index/constraint columns may be expressions (e.g. `lower(email)`). */
function columnNames(entries: readonly unknown[]): string[] {
  return entries.map((entry) => {
    const name = (entry as { readonly name?: unknown }).name;
    return typeof name === 'string' ? name : '(expression)';
  });
}

const ALL_TABLES = {
  tenants,
  users,
  workflows,
  workflow_versions: workflowVersions,
  api_keys: apiKeys,
  events,
  workflow_runs: workflowRuns,
};
const TENANT_SCOPED = {
  users,
  workflows,
  workflow_versions: workflowVersions,
  api_keys: apiKeys,
  events,
  workflow_runs: workflowRuns,
};

describe('table naming', () => {
  it('uses snake_case plural table names in the public schema', () => {
    for (const [expected, table] of Object.entries(ALL_TABLES)) {
      const config = getTableConfig(table);
      expect(config.name).toBe(expected);
      expect(config.schema).toBeUndefined();
    }
  });
});

describe('primary keys', () => {
  it('every table has a single uuid primary key with an application-side default', () => {
    for (const table of Object.values(ALL_TABLES)) {
      const primaries = getTableConfig(table).columns.filter((c) => c.primary);

      expect(primaries).toHaveLength(1);
      expect(primaries[0]?.name).toBe('id');
      expect(primaries[0]?.getSQLType()).toBe('uuid');
      // A UUIDv7 supplied by $defaultFn (newId), not a DB-side gen_random_uuid()
      // (which would be a v4). Still reports hasDefault, so no id is ever needed
      // at the call site.
      expect(primaries[0]?.hasDefault).toBe(true);
    }
  });
});

describe('tenant scoping', () => {
  it('every tenant-scoped table carries a NOT NULL uuid tenant_id', () => {
    for (const [name, table] of Object.entries(TENANT_SCOPED)) {
      const tenantId = columns(table).get('tenant_id');

      expect(tenantId, `${name} must have tenant_id`).toBeDefined();
      expect(tenantId?.getSQLType()).toBe('uuid');
      expect(tenantId?.notNull).toBe(true);
    }
  });

  it('tenant_id is anchored to a real tenant on every table, directly or compositely', () => {
    for (const [name, table] of Object.entries(TENANT_SCOPED)) {
      const constrains = getTableConfig(table).foreignKeys.some((fk) =>
        columnNames(fk.reference().columns).includes('tenant_id'),
      );

      expect(constrains, `${name}.tenant_id must be covered by a foreign key`).toBe(true);
    }
  });

  it('deleting a tenant cascades rather than orphaning rows', () => {
    for (const table of Object.values(TENANT_SCOPED)) {
      for (const fk of getTableConfig(table).foreignKeys) {
        expect(fk.onDelete).toBe('cascade');
      }
    }
  });
});

describe('timestamps', () => {
  it('are always timestamptz, never a naive local timestamp', () => {
    for (const table of Object.values(ALL_TABLES)) {
      for (const c of getTableConfig(table).columns) {
        if (!c.name.endsWith('_at')) continue;
        expect(c.getSQLType(), `${c.name} must be timezone-aware`).toBe(
          'timestamp with time zone',
        );
      }
    }
  });

  it('record-lifecycle columns (created_at/updated_at) are NOT NULL with a default', () => {
    for (const table of Object.values(ALL_TABLES)) {
      for (const c of getTableConfig(table).columns) {
        if (c.name !== 'created_at' && c.name !== 'updated_at') continue;
        expect(c.notNull, `${c.name} must be NOT NULL`).toBe(true);
        expect(c.hasDefault, `${c.name} must have a default`).toBe(true);
      }
    }
  });

  it('event columns (last_used_at, revoked_at) are nullable — absence is meaningful', () => {
    // These record that something happened; null legitimately means "not yet".
    // They must never be forced NOT NULL or given a default that would fabricate
    // an event time.
    for (const name of ['last_used_at', 'revoked_at'] as const) {
      const c = column(apiKeys, name);
      expect(c.notNull, `${name} must be nullable`).toBe(false);
      expect(c.hasDefault, `${name} must not have a default`).toBe(false);
    }
  });
});

describe('enumerated columns', () => {
  it('constrain status and trigger values at the type level', () => {
    expect(tenantStatus.enumValues).toEqual(['active', 'suspended']);
    expect(userStatus.enumValues).toEqual(['active', 'disabled']);
    expect(workflowStatus.enumValues).toEqual(['draft', 'active', 'disabled']);
    expect(triggerType.enumValues).toEqual(['webhook']);
    expect(workflowRunStatus.enumValues).toEqual([
      'queued',
      'running',
      'waiting',
      'succeeded',
      'failed',
      'cancelled',
    ]);
  });

  it('are applied to the columns that use them, with defaults where sensible', () => {
    expect(column(tenants, 'status').getSQLType()).toBe('tenant_status');
    expect(column(users, 'status').getSQLType()).toBe('user_status');
    expect(column(workflows, 'status').getSQLType()).toBe('workflow_status');
    expect(column(workflowVersions, 'trigger_type').getSQLType()).toBe('trigger_type');

    expect(column(workflows, 'status').hasDefault).toBe(true);
    // A version's trigger is a deliberate authoring decision, not a default.
    expect(column(workflowVersions, 'trigger_type').hasDefault).toBe(false);
  });
});

describe('users', () => {
  it('is unique per tenant on a case-insensitive email', () => {
    const index = getTableConfig(users).indexes.find(
      (i) => i.config.name === 'users_tenant_id_email_key',
    );

    expect(index).toBeDefined();
    expect(index?.config.unique).toBe(true);
    // tenant_id leads, then lower(email) as an expression.
    expect(columnNames(index?.config.columns ?? [])).toEqual(['tenant_id', '(expression)']);
  });

  it('holds no authentication material', () => {
    const names = [...columns(users).keys()];

    for (const forbidden of ['password', 'password_hash', 'api_key', 'token', 'secret']) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe('workflows', () => {
  it('has a tenant-scoped listing index ordered by creation time', () => {
    const index = getTableConfig(workflows).indexes.find(
      (i) => i.config.name === 'workflows_tenant_id_created_at_idx',
    );

    expect(index).toBeDefined();
    expect(index?.config.unique).toBe(false);
    expect(columnNames(index?.config.columns ?? [])).toEqual(['tenant_id', 'created_at']);
  });

  it('exposes (tenant_id, id) as a unique constraint so versions can reference it', () => {
    const unique = getTableConfig(workflows).uniqueConstraints.find(
      (u) => u.name === 'workflows_tenant_id_id_key',
    );

    expect(unique).toBeDefined();
    expect(columnNames(unique?.columns ?? [])).toEqual(['tenant_id', 'id']);
  });

  it('does not point at an active version, avoiding a circular foreign key', () => {
    // The active-version flag lives on workflow_versions instead. See below.
    expect([...columns(workflows).keys()]).not.toContain('active_version_id');
  });
});

describe('workflow_versions', () => {
  it('stores the definition as a single jsonb document, not relational steps', () => {
    const definition = column(workflowVersions, 'definition');

    expect(definition.getSQLType()).toBe('jsonb');
    expect(definition.notNull).toBe(true);

    // A step graph shredded into columns would show up here as steps/next/etc.
    const names = [...columns(workflowVersions).keys()];
    for (const forbidden of ['step_type', 'step_order', 'next_step_id', 'connector_id']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('defaults trigger_config to an empty document', () => {
    const triggerConfig = column(workflowVersions, 'trigger_config');

    expect(triggerConfig.getSQLType()).toBe('jsonb');
    expect(triggerConfig.notNull).toBe(true);
    expect(triggerConfig.hasDefault).toBe(true);
  });

  it('is immutable: it has created_at but deliberately no updated_at', () => {
    const names = [...columns(workflowVersions).keys()];

    expect(names).toContain('created_at');
    expect(names).not.toContain('updated_at');
  });

  it('numbers versions uniquely within a workflow', () => {
    const unique = getTableConfig(workflowVersions).uniqueConstraints.find(
      (u) => u.name === 'workflow_versions_workflow_id_version_key',
    );

    expect(unique).toBeDefined();
    expect(columnNames(unique?.columns ?? [])).toEqual(['workflow_id', 'version']);
    expect(column(workflowVersions, 'version').getSQLType()).toBe('integer');
  });

  it('allows at most one active version per workflow, via a partial unique index', () => {
    const index = getTableConfig(workflowVersions).indexes.find(
      (i) => i.config.name === 'workflow_versions_one_active_per_workflow_idx',
    );

    expect(index).toBeDefined();
    expect(index?.config.unique).toBe(true);
    expect(columnNames(index?.config.columns ?? [])).toEqual(['workflow_id']);
    // The WHERE clause is what keeps this from forbidding multiple inactive rows.
    expect(index?.config.where).toBeDefined();
  });

  it('cannot be attached to a workflow belonging to a different tenant', () => {
    const foreignKeys = getTableConfig(workflowVersions).foreignKeys;

    expect(foreignKeys).toHaveLength(1);

    const reference = foreignKeys[0]?.reference();
    expect(columnNames(reference?.columns ?? [])).toEqual(['tenant_id', 'workflow_id']);
    expect(getTableConfig(reference!.foreignTable).name).toBe('workflows');
    // Composite target: tenant and workflow must agree.
    expect(columnNames(reference?.foreignColumns ?? [])).toEqual(['tenant_id', 'id']);
  });
});

describe('api_keys', () => {
  it('stores a hash and a prefix, never the plaintext key', () => {
    const names = [...columns(apiKeys).keys()];

    expect(names).toContain('key_hash');
    expect(names).toContain('prefix');
    // No column that could hold the key itself.
    for (const forbidden of ['key', 'plaintext', 'secret', 'token']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('resolves a key by a unique prefix', () => {
    const index = getTableConfig(apiKeys).indexes.find(
      (i) => i.config.name === 'api_keys_prefix_key',
    );

    expect(index).toBeDefined();
    expect(index?.config.unique).toBe(true);
    expect(columnNames(index?.config.columns ?? [])).toEqual(['prefix']);
  });

  it('supports revocation as a soft delete rather than a row removal', () => {
    const names = [...columns(apiKeys).keys()];
    expect(names).toContain('revoked_at');
    // Revocation and last-use are the only mutations, each with its own column;
    // there is no generic updated_at.
    expect(names).not.toContain('updated_at');
  });
});

describe('events', () => {
  it('captures the raw signal with a jsonb payload and a received_at', () => {
    const payload = column(events, 'payload');
    expect(payload.getSQLType()).toBe('jsonb');
    expect(payload.notNull).toBe(true);

    const receivedAt = column(events, 'received_at');
    expect(receivedAt.getSQLType()).toBe('timestamp with time zone');
    expect(receivedAt.notNull).toBe(true);
    expect(receivedAt.hasDefault).toBe(true);

    // An event is an immutable record of what arrived: no updated_at.
    expect([...columns(events).keys()]).not.toContain('updated_at');
  });

  it('makes ingestion idempotent per (tenant, source, dedupe_key)', () => {
    const unique = getTableConfig(events).uniqueConstraints.find(
      (u) => u.name === 'events_tenant_id_source_dedupe_key_key',
    );

    expect(unique).toBeDefined();
    expect(columnNames(unique?.columns ?? [])).toEqual(['tenant_id', 'source', 'dedupe_key']);
  });

  it('exposes (tenant_id, id) as a unique constraint so runs can reference it', () => {
    const unique = getTableConfig(events).uniqueConstraints.find(
      (u) => u.name === 'events_tenant_id_id_key',
    );

    expect(unique).toBeDefined();
    expect(columnNames(unique?.columns ?? [])).toEqual(['tenant_id', 'id']);
  });
});

describe('workflow_versions routing invariant', () => {
  it('allows at most one active version per (tenant, source), via a partial unique index', () => {
    const index = getTableConfig(workflowVersions).indexes.find(
      (i) => i.config.name === 'workflow_versions_one_active_per_tenant_source_idx',
    );

    expect(index).toBeDefined();
    expect(index?.config.unique).toBe(true);
    // tenant_id leads, then the extracted trigger_config->>'source' as an expression.
    expect(columnNames(index?.config.columns ?? [])).toEqual(['tenant_id', '(expression)']);
    // The WHERE (is_active) clause is what scopes this to active versions only.
    expect(index?.config.where).toBeDefined();
  });
});

describe('workflow_runs', () => {
  it('starts queued and carries a jsonb context', () => {
    expect(column(workflowRuns, 'status').getSQLType()).toBe('workflow_run_status');
    expect(column(workflowRuns, 'status').hasDefault).toBe(true);

    const context = column(workflowRuns, 'context');
    expect(context.getSQLType()).toBe('jsonb');
    expect(context.notNull).toBe(true);
    expect(context.hasDefault).toBe(true);
  });

  it('pins both the workflow and the exact version at creation', () => {
    const names = [...columns(workflowRuns).keys()];
    expect(names).toContain('workflow_id');
    expect(names).toContain('workflow_version_id');
    expect(names).toContain('event_id');
  });

  it('cannot attach to a workflow, version or event of a different tenant', () => {
    const foreignKeys = getTableConfig(workflowRuns).foreignKeys;
    expect(foreignKeys).toHaveLength(3);

    // Every FK is composite on (tenant_id, X) → parent(tenant_id, id).
    const targets = foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        columns: columnNames(ref.columns),
        table: getTableConfig(ref.foreignTable).name,
        foreignColumns: columnNames(ref.foreignColumns),
      };
    });

    for (const t of targets) {
      expect(t.columns[0]).toBe('tenant_id');
      expect(t.foreignColumns).toEqual(['tenant_id', 'id']);
    }
    expect(targets.map((t) => t.table).sort()).toEqual(['events', 'workflow_versions', 'workflows']);
  });
});
