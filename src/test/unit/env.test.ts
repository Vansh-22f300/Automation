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
      WORKER_SHUTDOWN_TIMEOUT_MS: 10_000,
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

describe('parseEnv / WORKER_SHUTDOWN_TIMEOUT_MS', () => {
  it('defaults to 10000ms', () => {
    expect(parseEnv({ ...base }).WORKER_SHUTDOWN_TIMEOUT_MS).toBe(10_000);
  });

  it('coerces from a string', () => {
    expect(parseEnv({ ...base, WORKER_SHUTDOWN_TIMEOUT_MS: '2500' }).WORKER_SHUTDOWN_TIMEOUT_MS).toBe(2500);
  });

  it('rejects zero, negatives, fractions and absurd values', () => {
    for (const value of ['0', '-1', '2.5', '999999']) {
      expect(() => parseEnv({ ...base, WORKER_SHUTDOWN_TIMEOUT_MS: value })).toThrow(EnvValidationError);
    }
  });
});

describe('parseEnv / Claude credentials', () => {
  it('boots with no Claude credential at all (provider is created lazily)', () => {
    const env = parseEnv({ ...base });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('accepts a direct API key alone (x-api-key mode)', () => {
    const env = parseEnv({ ...base, ANTHROPIC_API_KEY: 'sk-ant-xyz' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-xyz');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('accepts a bearer auth token alone (gateway mode)', () => {
    const env = parseEnv({ ...base, ANTHROPIC_AUTH_TOKEN: 'gw-token' });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('gw-token');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('rejects configuring both an API key and an auth token (ambiguous)', () => {
    expect(
      offendingVariables(() =>
        parseEnv({ ...base, ANTHROPIC_API_KEY: 'sk-ant-xyz', ANTHROPIC_AUTH_TOKEN: 'gw-token' }),
      ),
    ).toContain('ANTHROPIC_AUTH_TOKEN');
  });

  it('rejects an explicitly-empty auth token', () => {
    expect(offendingVariables(() => parseEnv({ ...base, ANTHROPIC_AUTH_TOKEN: '' }))).toContain(
      'ANTHROPIC_AUTH_TOKEN',
    );
  });

  it('never echoes a credential in its error message', () => {
    try {
      parseEnv({ ...base, ANTHROPIC_API_KEY: 'sk-ant-SECRET', ANTHROPIC_AUTH_TOKEN: 'BEARER-SECRET' });
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      const message = (error as EnvValidationError).message;
      expect(message).not.toContain('sk-ant-SECRET');
      expect(message).not.toContain('BEARER-SECRET');
    }
  });
});

describe('parseEnv / ANTHROPIC_BASE_URL', () => {
  it('accepts a gateway origin with no path', () => {
    const env = parseEnv({
      ...base,
      ANTHROPIC_AUTH_TOKEN: 'gw-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
    });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example.com');
  });

  it('accepts a gateway origin with a non-/v1 base path', () => {
    const env = parseEnv({ ...base, ANTHROPIC_BASE_URL: 'https://gateway.example.com/api' });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gateway.example.com/api');
  });

  it('rejects a base URL ending in /v1 (would double-prefix to /v1/v1/messages)', () => {
    expect(
      offendingVariables(() => parseEnv({ ...base, ANTHROPIC_BASE_URL: 'https://gateway.example.com/v1' })),
    ).toContain('ANTHROPIC_BASE_URL');
    expect(
      offendingVariables(() => parseEnv({ ...base, ANTHROPIC_BASE_URL: 'https://gateway.example.com/v1/' })),
    ).toContain('ANTHROPIC_BASE_URL');
  });

  it('rejects a non-http(s) scheme and a non-URL string', () => {
    expect(offendingVariables(() => parseEnv({ ...base, ANTHROPIC_BASE_URL: 'ftp://x/y' }))).toContain(
      'ANTHROPIC_BASE_URL',
    );
    expect(offendingVariables(() => parseEnv({ ...base, ANTHROPIC_BASE_URL: 'not a url' }))).toContain(
      'ANTHROPIC_BASE_URL',
    );
  });

  describe('CREDENTIAL_ENCRYPTION_KEY', () => {
    it('is optional — the app parses without it', () => {
      expect(parseEnv({ ...base })).not.toHaveProperty('CREDENTIAL_ENCRYPTION_KEY');
    });

    it('accepts 64 hex characters', () => {
      const hex = 'a'.repeat(64);
      expect(parseEnv({ ...base, CREDENTIAL_ENCRYPTION_KEY: hex }).CREDENTIAL_ENCRYPTION_KEY).toBe(hex);
    });

    it('accepts a base64 value decoding to 32 bytes', () => {
      const b64 = Buffer.alloc(32, 7).toString('base64');
      expect(parseEnv({ ...base, CREDENTIAL_ENCRYPTION_KEY: b64 }).CREDENTIAL_ENCRYPTION_KEY).toBe(b64);
    });

    it('rejects a key of the wrong length', () => {
      expect(offendingVariables(() => parseEnv({ ...base, CREDENTIAL_ENCRYPTION_KEY: 'deadbeef' }))).toContain(
        'CREDENTIAL_ENCRYPTION_KEY',
      );
      expect(
        offendingVariables(() => parseEnv({ ...base, CREDENTIAL_ENCRYPTION_KEY: 'a'.repeat(63) })),
      ).toContain('CREDENTIAL_ENCRYPTION_KEY');
    });

    it('rejects an explicitly empty value', () => {
      expect(offendingVariables(() => parseEnv({ ...base, CREDENTIAL_ENCRYPTION_KEY: '' }))).toContain(
        'CREDENTIAL_ENCRYPTION_KEY',
      );
    });
  });
});
