import { describe, expect, it } from 'vitest';
import { EnvValidationError, parseEnv } from '@/config/env.js';

describe('parseEnv', () => {
  it('applies defaults when nothing is set', () => {
    const env = parseEnv({});

    expect(env).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      HOST: '127.0.0.1',
      PORT: 3000,
    });
  });

  it('coerces PORT from a string to a number', () => {
    expect(parseEnv({ PORT: '8080' }).PORT).toBe(8080);
  });

  it('ignores unrelated environment variables', () => {
    const env = parseEnv({ PATH: '/usr/bin', SOME_OTHER_VAR: 'x' });

    expect(env.NODE_ENV).toBe('development');
    expect(env).not.toHaveProperty('PATH');
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => parseEnv({ PORT: 'not-a-number' })).toThrow(EnvValidationError);
  });

  it('rejects an out-of-range PORT', () => {
    expect(() => parseEnv({ PORT: '70000' })).toThrow(EnvValidationError);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => parseEnv({ NODE_ENV: 'staging' })).toThrow(EnvValidationError);
  });

  it('rejects an empty HOST', () => {
    expect(() => parseEnv({ HOST: '' })).toThrow(EnvValidationError);
  });

  it('names every offending variable in the error', () => {
    try {
      parseEnv({ PORT: 'abc', NODE_ENV: 'staging' });
      expect.unreachable('parseEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const variables = (error as EnvValidationError).issues.map((i) => i.variable);
      expect(variables).toContain('PORT');
      expect(variables).toContain('NODE_ENV');
    }
  });
});
