/**
 * The authenticated GitHub identity, and the strict parse that establishes it.
 *
 * GitHub's `GET /user` returns dozens of fields; we deliberately validate and keep
 * only the three that identify the connected account — the numeric `id` (the stable,
 * rename-proof identity), the `login` (the human handle, used as the connection
 * name), and the optional display `name`. The object schema is non-strict so GitHub's
 * other fields are simply dropped rather than rejected: we never persist the whole
 * response, only this projection.
 *
 * `id` is the authoritative identity; `login` can be renamed on GitHub, which is why
 * it is kept as the display name while the numeric id is stored in metadata.
 */

import { z } from 'zod';

/** Validates the identity fields we read from `GET /user`; extras are stripped. */
export const GITHUB_IDENTITY_SCHEMA = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1).max(39),
  /** GitHub returns `name: null` for accounts with no display name. */
  name: z.string().nullish(),
});

/** The connected GitHub account, normalized to exactly what we store/return. */
export interface GithubIdentity {
  readonly id: number;
  readonly login: string;
  readonly name?: string;
}

/**
 * Parse a `GET /user` body into a {@link GithubIdentity}, or `undefined` when the
 * response does not carry a well-formed identity (so the caller can raise the error
 * shape appropriate to its layer — an OAuth error at the callback, a tool error at
 * execution). Never throws; never echoes the raw body.
 */
export function parseGithubIdentity(body: unknown): GithubIdentity | undefined {
  const parsed = GITHUB_IDENTITY_SCHEMA.safeParse(body);
  if (!parsed.success) return undefined;
  const { id, login, name } = parsed.data;
  return {
    id,
    login,
    ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
  };
}
