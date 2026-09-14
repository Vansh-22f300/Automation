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
      TRUST_PROXY: false,
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
    const env = parseEnv({
      ...base,
      ANTHROPIC_AUTH_TOKEN: 'gw-token',
      ANTHROPIC_BASE_URL: 'https://gateway.example.com/api',
    });
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

  describe('TRUST_PROXY', () => {
    it('defaults to false (safe for local/dev)', () => {
      expect(parseEnv({ ...base }).TRUST_PROXY).toBe(false);
    });

    it('accepts false and 0 as false', () => {
      expect(parseEnv({ ...base, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
      expect(parseEnv({ ...base, TRUST_PROXY: '0' }).TRUST_PROXY).toBe(false);
    });

    it('accepts true and 1 as true', () => {
      expect(parseEnv({ ...base, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
      expect(parseEnv({ ...base, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(true);
    });

    it('accepts known proxy range names', () => {
      expect(parseEnv({ ...base, TRUST_PROXY: 'loopback' }).TRUST_PROXY).toBe('loopback');
      expect(parseEnv({ ...base, TRUST_PROXY: 'uniquelocal' }).TRUST_PROXY).toBe('uniquelocal');
    });

    it('accepts IP addresses and CIDR ranges', () => {
      expect(parseEnv({ ...base, TRUST_PROXY: '127.0.0.1' }).TRUST_PROXY).toBe('127.0.0.1');
      expect(parseEnv({ ...base, TRUST_PROXY: '10.0.0.0/8' }).TRUST_PROXY).toBe('10.0.0.0/8');
      expect(parseEnv({ ...base, TRUST_PROXY: '10.0.0.0/8, 172.16.0.0/12' }).TRUST_PROXY).toBe(
        '10.0.0.0/8, 172.16.0.0/12',
      );
    });

    it('rejects nonsense values', () => {
      expect(offendingVariables(() => parseEnv({ ...base, TRUST_PROXY: 'maybe' }))).toContain('TRUST_PROXY');
      expect(offendingVariables(() => parseEnv({ ...base, TRUST_PROXY: '999.999.999.999' }))).toContain(
        'TRUST_PROXY',
      );
      expect(offendingVariables(() => parseEnv({ ...base, TRUST_PROXY: '10.0.0.0/999' }))).toContain(
        'TRUST_PROXY',
      );
    });

    it('rejects an empty string', () => {
      expect(offendingVariables(() => parseEnv({ ...base, TRUST_PROXY: '' }))).toContain('TRUST_PROXY');
    });
  });
});

describe('parseEnv / production DATABASE_URL', () => {
  const hosted = 'postgresql://app:secret@db.example.com:5432/ai_workforce';
  const localhostVariants = [
    'postgresql://app:secret@localhost:5432/ai_workforce',
    'postgresql://app:secret@127.0.0.1:5432/ai_workforce',
    'postgresql://app:secret@[::1]:5432/ai_workforce',
    'postgresql://app:secret@[::ffff:127.0.0.1]:5432/ai_workforce',
    'postgresql://app:secret@localhost/ai_workforce',
  ];

  it('allows localhost in development', () => {
    for (const url of localhostVariants) {
      expect(parseEnv({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
    }
  });

  it('rejects localhost variants in production', () => {
    for (const url of localhostVariants) {
      expect(
        offendingVariables(() =>
          parseEnv({ ...base, NODE_ENV: 'production', HOST: '0.0.0.0', DATABASE_URL: url }),
        ),
      ).toContain('DATABASE_URL');
    }
  });

  it('rejects a test database name in production (case-insensitive, URL-decoded)', () => {
    const variants = [
      'postgresql://app:secret@db.example.com:5432/ai_workforce_test',
      'postgresql://app:secret@db.example.com:5432/AI_WORKFORCE_TEST',
      'postgresql://app:secret@db.example.com:5432/ai_workforce_TEST_foo',
      'postgresql://user:pw@ep.example.com:5432/main_test?sslmode=require',
      'postgresql://app:secret@db.example.com:5432/ai%5fworkforce%5ftest', // ai_workforce_test encoded
    ];
    for (const url of variants) {
      expect(
        offendingVariables(() =>
          parseEnv({ ...base, NODE_ENV: 'production', HOST: '0.0.0.0', DATABASE_URL: url }),
        ),
      ).toContain('DATABASE_URL');
    }
  });

  it('allows a hosted non-test database in production', () => {
    expect(parseEnv({ ...base, NODE_ENV: 'production', DATABASE_URL: hosted, HOST: '0.0.0.0' }).DATABASE_URL).toBe(
      hosted,
    );
  });

  it('never echoes the connection string when rejecting production DATABASE_URL', () => {
    const secretUrl = 'postgresql://app:sup3rS3cret@localhost:5432/ai_workforce_test';
    try {
      parseEnv({ DATABASE_URL: secretUrl, NODE_ENV: 'production', HOST: '0.0.0.0' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as EnvValidationError).message).not.toContain('sup3rS3cret');
      expect((error as EnvValidationError).message).not.toContain(secretUrl);
    }
  });
});

describe('parseEnv / TEST_DATABASE_URL isolation', () => {
  const db = 'postgresql://app:secret@db.example.com:5432/ai_workforce';
  const dbTest = 'postgresql://app:secret@db.example.com:5432/ai_workforce_test';

  it('allows missing TEST_DATABASE_URL', () => {
    expect(parseEnv({ ...base }).TEST_DATABASE_URL).toBeUndefined();
  });

  it('allows a distinct test database', () => {
    expect(
      parseEnv({ ...base, TEST_DATABASE_URL: dbTest }).TEST_DATABASE_URL,
    ).toBe(dbTest);
  });

  it('rejects identical URLs', () => {
    expect(offendingVariables(() => parseEnv({ ...base, TEST_DATABASE_URL: db }))).toContain(
      'TEST_DATABASE_URL',
    );
  });

  it('rejects semantically identical URLs with different credentials', () => {
    const altUser = 'postgresql://other:otherpass@db.example.com:5432/ai_workforce';
    expect(offendingVariables(() => parseEnv({ DATABASE_URL: db, TEST_DATABASE_URL: altUser }))).toContain(
      'TEST_DATABASE_URL',
    );
  });

  it('rejects semantically identical URLs with different query strings', () => {
    const withQuery = 'postgresql://app:secret@db.example.com:5432/ai_workforce?sslmode=require';
    expect(offendingVariables(() => parseEnv({ DATABASE_URL: db, TEST_DATABASE_URL: withQuery }))).toContain(
      'TEST_DATABASE_URL',
    );
    expect(
      offendingVariables(() => parseEnv({ DATABASE_URL: withQuery, TEST_DATABASE_URL: db })),
    ).toContain('TEST_DATABASE_URL');
  });

  it('rejects semantically identical URLs ignoring trailing slash and default port', () => {
    const noPort = 'postgresql://app:secret@db.example.com/ai_workforce';
    const withPort = 'postgresql://app:secret@db.example.com:5432/ai_workforce';
    expect(offendingVariables(() => parseEnv({ DATABASE_URL: withPort, TEST_DATABASE_URL: noPort }))).toContain(
      'TEST_DATABASE_URL',
    );
    const withSlash = 'postgresql://app:secret@db.example.com:5432/ai_workforce/';
    expect(offendingVariables(() => parseEnv({ DATABASE_URL: db, TEST_DATABASE_URL: withSlash }))).toContain(
      'TEST_DATABASE_URL',
    );
  });

  it('rejects case-insensitive host/database matches', () => {
    const upper = 'postgresql://app:secret@DB.EXAMPLE.COM:5432/AI_WORKFORCE';
    expect(offendingVariables(() => parseEnv({ DATABASE_URL: db, TEST_DATABASE_URL: upper }))).toContain(
      'TEST_DATABASE_URL',
    );
  });

  it('rejects URL-encoded database name equivalence', () => {
    const encoded = 'postgresql://app:secret@db.example.com:5432/ai%5fworkforce';
    expect(offendingVariables(() => parseEnv({ DATABASE_URL: db, TEST_DATABASE_URL: encoded }))).toContain(
      'TEST_DATABASE_URL',
    );
  });

  it('allows different database/host/port', () => {
    expect(
      parseEnv({ DATABASE_URL: db, TEST_DATABASE_URL: 'postgresql://app:secret@db.example.com:5432/other_db' })
        .TEST_DATABASE_URL,
    ).toBeDefined();
    expect(
      parseEnv({ DATABASE_URL: db, TEST_DATABASE_URL: 'postgresql://app:secret@other.example.com:5432/ai_workforce' })
        .TEST_DATABASE_URL,
    ).toBeDefined();
    expect(
      parseEnv({ DATABASE_URL: db, TEST_DATABASE_URL: 'postgresql://app:secret@db.example.com:5433/ai_workforce' })
        .TEST_DATABASE_URL,
    ).toBeDefined();
  });

  it('never echoes URLs in the isolation error', () => {
    const secret = 'postgresql://app:sup3rS3cret@db.example.com:5432/ai_workforce';
    try {
      parseEnv({ DATABASE_URL: secret, TEST_DATABASE_URL: secret });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as EnvValidationError).message).not.toContain('sup3rS3cret');
    }
  });
});

describe('parseEnv / ANTHROPIC_BASE_URL coherence', () => {
  it('rejects base URL without any credential', () => {
    expect(
      offendingVariables(() => parseEnv({ ...base, ANTHROPIC_BASE_URL: 'https://gateway.example.com' })),
    ).toContain('ANTHROPIC_BASE_URL');
  });

  it('accepts base URL with an API key', () => {
    expect(
      parseEnv({ ...base, ANTHROPIC_API_KEY: 'sk-ant-xyz', ANTHROPIC_BASE_URL: 'https://gateway.example.com' })
        .ANTHROPIC_BASE_URL,
    ).toBe('https://gateway.example.com');
  });

  it('accepts base URL with an auth token', () => {
    expect(
      parseEnv({
        ...base,
        ANTHROPIC_AUTH_TOKEN: 'gw-token',
        ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      }).ANTHROPIC_BASE_URL,
    ).toBe('https://gateway.example.com');
  });

  it('allows http base URL in development', () => {
    expect(
      parseEnv({
        ...base,
        ANTHROPIC_AUTH_TOKEN: 'gw-token',
        ANTHROPIC_BASE_URL: 'http://gateway.example.com',
      }).ANTHROPIC_BASE_URL,
    ).toBe('http://gateway.example.com');
  });

  it('rejects http base URL in production', () => {
    expect(
      offendingVariables(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          HOST: '0.0.0.0',
          DATABASE_URL: 'postgresql://app:secret@db.example.com:5432/ai_workforce',
          ANTHROPIC_AUTH_TOKEN: 'gw-token',
          ANTHROPIC_BASE_URL: 'http://gateway.example.com',
        }),
      ),
    ).toContain('ANTHROPIC_BASE_URL');
  });

  it('accepts https base URL in production', () => {
    expect(
      parseEnv({
        ...base,
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        DATABASE_URL: 'postgresql://app:secret@db.example.com:5432/ai_workforce',
        ANTHROPIC_AUTH_TOKEN: 'gw-token',
        ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      }).ANTHROPIC_BASE_URL,
    ).toBe('https://gateway.example.com');
  });
});

describe('parseEnv / production HOST', () => {
  const hostedDb = 'postgresql://app:secret@db.example.com:5432/ai_workforce';

  it('allows 127.0.0.1 in development', () => {
    expect(parseEnv({ ...base, HOST: '127.0.0.1' }).HOST).toBe('127.0.0.1');
  });

  it('rejects loopback hosts in production', () => {
    const loopbacks = ['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'];
    for (const host of loopbacks) {
      expect(
        offendingVariables(() =>
          parseEnv({ ...base, NODE_ENV: 'production', HOST: host, DATABASE_URL: hostedDb }),
        ),
      ).toContain('HOST');
    }
  });

  it('accepts 0.0.0.0 in production', () => {
    expect(parseEnv({ ...base, NODE_ENV: 'production', HOST: '0.0.0.0', DATABASE_URL: hostedDb }).HOST).toBe(
      '0.0.0.0',
    );
  });

  it('accepts a non-loopback custom host in production', () => {
    expect(parseEnv({ ...base, NODE_ENV: 'production', HOST: '10.0.0.5', DATABASE_URL: hostedDb }).HOST).toBe(
      '10.0.0.5',
    );
  });
});
