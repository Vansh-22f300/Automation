/**
 * Unit tests for return-path validation (`@/oauth/return-path`) — the open-redirect
 * defence (state design §7). The path a browser wants to land on after the flow is
 * untrusted input: these pin that only safe internal relative paths are accepted,
 * that protocol-relative and absolute URLs are refused, and that an unsafe value is
 * rejected LOUDLY (a `BadRequestError`) rather than silently coerced to the default.
 */

import { describe, expect, it } from 'vitest';

import { BadRequestError } from '@/api/errors.js';
import { DEFAULT_RETURN_PATH, isSafeInternalPath, resolveReturnPath } from '@/oauth/return-path.js';

describe('isSafeInternalPath', () => {
  it('accepts site-relative paths (with query strings)', () => {
    for (const value of ['/', '/connections', '/a/b?c=d', '/connections?tab=github']) {
      expect(isSafeInternalPath(value)).toBe(true);
    }
  });

  it('rejects empty, protocol-relative, absolute, and character-smuggling paths', () => {
    for (const value of [
      '', // empty
      '//evil.example', // protocol-relative (off-site)
      '/\\evil.example', // backslash protocol-relative
      'http://evil.example', // absolute URL, no leading slash
      '/a b', // whitespace
      '/a\tb', // tab
      '/a\nb', // newline
      '/a\u0000b', // NUL control
      '/a\u001fb', // control
      '/a\u007fb', // DEL
      '/a\\b', // backslash anywhere
    ]) {
      expect(isSafeInternalPath(value)).toBe(false);
    }
  });

  it('is length-bounded at 512 chars — 512 accepted, 513 rejected', () => {
    expect(isSafeInternalPath(`/${'a'.repeat(511)}`)).toBe(true); // exactly 512
    expect(isSafeInternalPath(`/${'a'.repeat(512)}`)).toBe(false); // 513
  });
});

describe('resolveReturnPath', () => {
  it('falls back to the default when the caller names no path', () => {
    expect(resolveReturnPath(undefined)).toBe(DEFAULT_RETURN_PATH);
    expect(DEFAULT_RETURN_PATH).toBe('/connections');
  });

  it('returns a present-and-safe path unchanged', () => {
    expect(resolveReturnPath('/connections?tab=github')).toBe('/connections?tab=github');
  });

  it('rejects a present-but-unsafe path loudly, never coercing to the default', () => {
    expect(() => resolveReturnPath('//evil.example')).toThrow(BadRequestError);
    expect(() => resolveReturnPath('//evil.example')).toThrow(
      'returnPath must be a safe internal path beginning with "/"',
    );
  });
});
