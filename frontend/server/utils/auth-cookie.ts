/**
 * HttpOnly session-cookie helpers for the BFF auth routes. The raw backend
 * session token lives only in the login response we read from Fastify and in
 * this HttpOnly cookie's value — never in a response body, client JS, or a log.
 * The backend still stores only the token's SHA-256 hash (Phase 2/3).
 */
import { deleteCookie, getCookie, getRequestURL, setCookie, type H3Event } from 'h3';

/** The single browser-visible credential. HttpOnly; never readable by JS. */
export const SESSION_COOKIE_NAME = 'aw_session';

/** Hard cap matching the backend's 24h absolute session lifetime. */
const MAX_COOKIE_AGE_SECONDS = 24 * 60 * 60;

/** Secure tracks the effective request scheme (proxy-aware via x-forwarded-
 * proto, honoured by getRequestURL): HTTPS ⇒ Secure; plain-HTTP dev omits it. */
function isSecureRequest(event: H3Event): boolean {
  return getRequestURL(event).protocol === 'https:';
}

/** Max-Age from the backend's absolute expiresAt, clamped to [0, 24h]; full
 * lifetime if unparseable. */
function maxAgeFromExpiry(expiresAtIso: string): number {
  const deltaMs = Date.parse(expiresAtIso) - Date.now();
  if (Number.isNaN(deltaMs)) return MAX_COOKIE_AGE_SECONDS;
  return Math.max(0, Math.min(MAX_COOKIE_AGE_SECONDS, Math.floor(deltaMs / 1000)));
}

export function readSessionCookie(event: H3Event): string | undefined {
  return getCookie(event, SESSION_COOKIE_NAME);
}

export function setSessionCookie(event: H3Event, token: string, expiresAtIso: string): void {
  setCookie(event, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isSecureRequest(event),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeFromExpiry(expiresAtIso),
  });
}

export function clearSessionCookie(event: H3Event): void {
  deleteCookie(event, SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: isSecureRequest(event),
    sameSite: 'lax',
    path: '/',
  });
}
