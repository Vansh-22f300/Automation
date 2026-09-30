/**
 * Request-URL redaction for the structured logger.
 *
 * WHY THIS EXISTS. Fastify's built-in request logging emits an "incoming request"
 * line whose serialized `req` carries `req.url` VERBATIM — path *and* query string.
 * The public OAuth callback (`GET /oauth/:provider/callback?state=…&code=…`) is
 * unauthenticated and arrives with two sensitive query values: the opaque `state`
 * (a single-use bearer of the initiating context) and the authorization `code`.
 * Left alone, both would be written into production request logs. This module
 * censors those values wherever a request URL is logged, while leaving the path
 * (route + provider) and every non-sensitive parameter byte-for-byte intact — so
 * useful request logging is preserved and unrelated routes are unaffected.
 *
 * WHY A CENSOR, NOT A DROP. pino's `redact` blanks a whole value; a custom `req`
 * serializer would have to re-declare Fastify's field shape and risk drift. A
 * function censor on the single path `req.url` (see {@link redactSensitiveQuery})
 * transforms only the URL string, keeps Fastify's serializer and all other fields,
 * and is inert for any URL that carries none of the sensitive keys.
 */

/**
 * Query-parameter names whose VALUES must never reach a log line. Matched
 * case-insensitively. Covers the OAuth authorization-code round-trip secrets and
 * the token/secret names that could appear on any future OAuth-shaped URL — the
 * exact set requirement 2 enumerates (state, authorization code, PKCE verifier,
 * access token, refresh token, client secret), plus obvious siblings.
 */
export const SENSITIVE_QUERY_KEYS: ReadonlySet<string> = new Set([
  'state',
  'code',
  'code_verifier',
  'access_token',
  'refresh_token',
  'client_secret',
  'id_token',
  'token',
]);

/** The placeholder written in place of a sensitive value. */
export const REDACTED = '[REDACTED]';

/**
 * Mask the values of {@link SENSITIVE_QUERY_KEYS} in a request URL string.
 *
 * - No query string (`?` absent) → the input is returned unchanged.
 * - No sensitive key present → the ORIGINAL string reference is returned
 *   unchanged, so a non-OAuth route's log line is byte-for-byte identical to
 *   before this module existed.
 * - Otherwise only the offending values become `[REDACTED]`; key names, ordering,
 *   every other parameter, the path, and any `#fragment` are preserved.
 *
 * Parsing is done by hand (not `URLSearchParams`) precisely so untouched
 * parameters keep their exact original bytes — re-encoding could silently alter
 * an unrelated route's logged URL, which would count as weakening its logging.
 *
 * Non-string input is passed through untouched: as a pino censor this runs only
 * against the serialized `req.url`, but staying total keeps it safe to reuse.
 */
export function redactSensitiveQuery(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const queryStart = value.indexOf('?');
  if (queryStart === -1) return value;

  const path = value.slice(0, queryStart);
  const afterQuestion = value.slice(queryStart + 1);

  // Keep a trailing fragment out of query parsing; URLs in logs rarely carry one,
  // but a `#...` must not be mistaken for a parameter.
  const fragmentStart = afterQuestion.indexOf('#');
  const query = fragmentStart === -1 ? afterQuestion : afterQuestion.slice(0, fragmentStart);
  const fragment = fragmentStart === -1 ? '' : afterQuestion.slice(fragmentStart);

  let redactedAny = false;
  const pairs = query.split('&').map((pair) => {
    if (pair === '') return pair;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);

    let decodedKey: string;
    try {
      decodedKey = decodeURIComponent(rawKey);
    } catch {
      decodedKey = rawKey;
    }

    if (SENSITIVE_QUERY_KEYS.has(decodedKey.toLowerCase())) {
      redactedAny = true;
      // Preserve the key's original bytes; replace only the value.
      return `${rawKey}=${REDACTED}`;
    }
    return pair;
  });

  if (!redactedAny) return value;
  return `${path}?${pairs.join('&')}${fragment}`;
}

/**
 * The pino `redact` configuration the root logger installs. Kept here so the
 * production factory and its regression test share ONE definition: the censor
 * runs on the single serialized path `req.url`, wherever a request is logged
 * (Fastify's "incoming request" line, or any manual `{ req }`).
 */
export const REQUEST_URL_REDACTION: {
  readonly paths: string[];
  readonly censor: (value: unknown) => unknown;
} = {
  paths: ['req.url'],
  censor: redactSensitiveQuery,
};
