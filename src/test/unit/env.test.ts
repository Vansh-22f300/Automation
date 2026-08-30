import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '@/config/env.js';

/**
 * DATABASE_URL is required and has no default, so every case that expects
 * success has to supply one. Deliberately not a real database.
 */
const VALID_DATABASE_URL = 'postgresql://app:secret@db.example.com:5432/ai_workforce';

/** A minimally valid environment, spread into each case and overridden. */
const base = { DATABASE_URL: VALID_DATABASE_URL } as const;

/** Collects the variable names an EnvValidationError blames. */
function offendingVariables(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof EnvValidationError) return error.issues.map((i) => i.variable);
    throw error;
  }
  throw new Error('expected parseEnv to throw EnvValidationError');
}

describe('parseEnv', () => {
  it('applies defaults when only the required variables are set', () => {
    const env = parseEnv({ ...base });

    expect(env).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      HOST: '127.0.0.1',
      PORT: 3000,
      DATABASE_URL: VALID_DATABASE_URL,
      DATABASE_POOL_MAX: 10,
      ANTHROPIC_MODEL: 'claude-opus-5',
    });
  });

  it('coerces PORT from a string to a number', () => {
    expect(parseEnv({ ...base, PORT: '8080' }).PORT).toBe(8080);
  });

  it('ignores unrelated environment variables', () => {
    const env = parseEnv({ ...base, PATH: '/usr/bin', SOME_OTHER_VAR: 'x' });

    expect(env.NODE_ENV).toBe('development');
    expect(env).not.toHaveProperty('PATH');
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => parseEnv({ ...base, PORT: 'not-a-number' })).toThrow(EnvValidationError);
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => parseEnv({ ...base, PORT: '70000' })).toThrow(EnvValidationError);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'staging' })).toThrow(EnvValidationError);
  });

  it('rejects an empty HOST', () => {
    expect(() => parseEnv({ ...base, HOST: '' })).toThrow(EnvValidationError);
  });

  it('names every offending variable in the error', () => {
    expect(offendingVariables(() => parseEnv({ ...base, PORT: 'abc', NODE_ENV: 'staging' })))
      .toEqual(expect.arrayContaining(['PORT', 'NODE_ENV']));
  });
});

describe('parseEnv / DATABASE_URL', () => {
  it('is required, with no fallback', () => {
    expect(() => parseEnv({})).toThrow(EnvValidationError);
    expect(offendingVariables(() => parseEnv({}))).toContain('DATABASE_URL');
  });

  it('explains that it must be a PostgreSQL connection string when missing', () => {
    try {
      parseEnv({});
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      const issue = (error as EnvValidationError).issues.find(
        (i) => i.variable === 'DATABASE_URL',
      );
      expect(issue?.message).toBe('must be set to a PostgreSQL connection string');
    }
  });

  it('rejects an empty value', () => {
    expect(offendingVariables(() => parseEnv({ DATABASE_URL: '' }))).toContain('DATABASE_URL');
  });

  it('rejects a string that is not a URL', () => {
    expect(offendingVariables(() => parseEnv({ DATABASE_URL: 'localhost:5432' }))).toContain(
      'DATABASE_URL',
    );
  });

  it('rejects a non-postgres scheme', () => {
    try {
      parseEnv({ DATABASE_URL: 'mysql://app:secret@db.example.com:3306/ai_workforce' });
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      const issue = (error as EnvValidationError).issues.find(
        (i) => i.variable === 'DATABASE_URL',
      );
      expect(issue?.message).toContain('postgres://');
    }
  });

  it('rejects a URL with no database name', () => {
    expect(
      offendingVariables(() => parseEnv({ DATABASE_URL: 'postgresql://db.example.com:5432' })),
    ).toContain('DATABASE_URL');
    expect(
      offendingVariables(() => parseEnv({ DATABASE_URL: 'postgresql://db.example.com:5432/' })),
    ).toContain('DATABASE_URL');
  });

  it('accepts both the postgres:// and postgresql:// schemes', () => {
    expect(parseEnv({ DATABASE_URL: 'postgres://u:p@h:5432/d' }).DATABASE_URL).toBe(
      'postgres://u:p@h:5432/d',
    );
    expect(parseEnv({ DATABASE_URL: 'postgresql://u:p@h:5432/d' }).DATABASE_URL).toBe(
      'postgresql://u:p@h:5432/d',
    );
  });

  it('accepts a managed-provider URL with query parameters and no explicit port', () => {
    const neonStyle = 'postgresql://user:pw@ep-cool-name.eu-central-1.aws.neon.tech/main?sslmode=require';

    expect(parseEnv({ DATABASE_URL: neonStyle }).DATABASE_URL).toBe(neonStyle);
  });

  it('never echoes the connection string in its error message', () => {
    // Failure output goes to stderr and is often captured by a supervisor, so a
    // password must not be able to reach it.
    try {
      parseEnv({ DATABASE_URL: 'mysql://app:sup3rs3cret@db.example.com:3306/x' });
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      expect((error as EnvValidationError).message).not.toContain('sup3rs3cret');
    }
  });
});

describe('parseEnv / DATABASE_POOL_MAX', () => {
  it('defaults to 10', () => {
    expect(parseEnv({ ...base }).DATABASE_POOL_MAX).toBe(10);
  });

  it('coerces from a string', () => {
    expect(parseEnv({ ...base, DATABASE_POOL_MAX: '4' }).DATABASE_POOL_MAX).toBe(4);
  });

  it('rejects zero, negatives, fractions and absurd values', () => {
    for (const value of ['0', '-1', '2.5', '1000']) {
      expect(() => parseEnv({ ...base, DATABASE_POOL_MAX: value })).toThrow(EnvValidationError);
    }
  });
});
