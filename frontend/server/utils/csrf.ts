/**
 * Server-side CSRF defence for state-changing BFF routes.
 *
 * SameSite=Lax alone is not sufficient (Phase 4 §7), so before forwarding any
 * mutation we require the request's Origin (Referer as a fallback) to match
 * this server's own origin or an explicitly configured trusted origin. GET/HEAD
 * are exempt and never call this. Missing BOTH Origin and Referer on a mutation
 * is rejected: real browsers always send Origin on cross-origin requests and on
 * same-origin POSTs issued via fetch, so its absence is treated as untrusted.
 * Trusted origins come from NUXT_TRUSTED_ORIGINS (comma-separated) — never a
 * broad wildcard such as `*.vercel.app`.
 */
import { getHeader, getRequestURL, type H3Event } from 'h3';

function parseTrusted(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function originOf(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * True when the request demonstrably originates from this server's own origin
 * or a configured trusted origin. Reusable across every state-changing route.
 */
export function isTrustedOrigin(event: H3Event): boolean {
  const runtimeConfig = useRuntimeConfig(event);
  const allowed = new Set<string>([
    getRequestURL(event).origin,
    ...parseTrusted((runtimeConfig as { trustedOrigins?: unknown }).trustedOrigins),
  ]);
  const claimed = getHeader(event, 'origin') ?? originOf(getHeader(event, 'referer'));
  if (claimed === undefined) return false;
  return allowed.has(claimed);
}
