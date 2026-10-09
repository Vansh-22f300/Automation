# GitHub OAuth App connector

The first real OAuth provider. A logged-in user connects a GitHub account from the
authenticated OAuth flow; the platform stores encrypted, tenant-scoped credentials and
exposes two GitHub tools to workflows. Built on the provider-neutral OAuth foundation
and connection store — no parallel auth system.

## Environment variables

| Variable | Secret? | Needed by | Notes |
| --- | --- | --- | --- |
| `GITHUB_CLIENT_ID` | No (rides in the browser authorize URL) | API + worker | OAuth App client id |
| `GITHUB_CLIENT_SECRET` | **Yes** (server-only; never logged/returned) | API + worker | OAuth App client secret |

Both-or-neither: setting only one is refused at startup (`env.ts` Invariant 8). Leave
both unset and GitHub is simply not registered — every GitHub OAuth lookup fails closed
(404) and the GitHub tools fail cleanly at execution for want of a connection. Both the
API and the worker need the pair: the API runs authorize / callback / revoke, the worker
runs tool execution and token refresh (refresh needs the client secret).

## Create the GitHub OAuth App

1. github.com → Settings → Developer settings → **OAuth Apps** → New OAuth App.
   (This is an *OAuth App*, not a *GitHub App* — the latter is a different flow and is
   out of scope here.)
2. **Authorization callback URL** — set it to exactly:

   ```
   ${APP_ORIGIN}/oauth/github/callback
   ```

   The redirect URI is built from `APP_ORIGIN` (never a request `Host` header), so it
   must match what you register here byte-for-byte.
3. To get **refresh tokens**, turn ON "token expiration" (expiring user tokens) in the
   OAuth App settings. GitHub then returns a refresh token and expiries; otherwise the
   access token is long-lived and no refresh token is issued.
4. Copy the client id and generate a client secret into your environment (never commit).

## Scopes

Fixed and minimal, requested on every authorize:

- `read:user` — read the authenticated identity (`GET /user`).
- `public_repo` — open issues on public repositories.
- `offline_access` — ask for a refresh token when token expiration is enabled.

The broad `repo` scope (private repositories) is deliberately **not** requested.

## Local development

1. Register an OAuth App with callback URL `http://localhost:3001/oauth/github/callback`
   (the default `APP_ORIGIN`). Enable token expiration if you want to exercise refresh.
2. In `.env` (git-ignored), set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`
   (see `.env.example`). Keep `APP_ORIGIN=http://localhost:3001`.
3. Start the API and worker. Start the GitHub flow from the frontend "Connect GitHub"
   action, which POSTs to `POST /v1/oauth/github/authorize` (authenticated) and
   redirects you to GitHub; GitHub returns to the Nuxt BFF callback, which forwards to
   `GET /oauth/github/callback`.

## Production

- Register the callback URL as `https://<your-domain>/oauth/github/callback` and set
  `APP_ORIGIN=https://<your-domain>` (production requires https + a non-loopback host).
- Set `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` on **both** the API and the worker
  services. Set `CREDENTIAL_ENCRYPTION_KEY` (or `CREDENTIAL_ENCRYPTION_KEYS`) so tokens
  can be encrypted at rest.

## Token refresh behavior

Access tokens are refreshed transparently at the execution boundary — the model never
sees, chooses, or refreshes a token:

- A still-valid access token is passed straight through.
- At/near expiry (default 60s skew), the stored refresh token is redeemed at
  `POST https://github.com/login/oauth/access_token`.
- GitHub **rotates** the refresh token on use; the new access token, new refresh token
  and new expiries are persisted. The old refresh token is never reused after rotation.
- The rotated set is written with a **compare-and-swap** on the credential ciphertext,
  so under concurrency exactly one refresher wins and any other re-reads the winner's
  freshly-persisted credential instead of replaying a rotated-away refresh token. The
  network refresh happens outside any DB transaction.
- An expired refresh token is a permanent, reconnect-required failure (no endless retry).

## Tools

- `github_get_authenticated_user` — no arguments; returns `{ id, login, name? }` for the
  connected account. The connection is chosen by trusted platform config, not the model.
- `github_create_issue` — strict args `{ owner, repo, title, body? }`; calls the fixed
  `POST /repos/{owner}/{repo}/issues`. `owner`/`repo` are charset-bounded and encoded, so
  no path/query/header/body can be injected. It is non-idempotent: an ambiguous outcome
  (5xx / transport failure) is held and surfaced, never auto-resent.

## Known limitations

- **GitHub Enterprise Server**: expiring tokens / refresh tokens are only available when
  the instance supports them. Without them, GitHub issues no refresh token; the stored
  connection then needs re-authorizing when its access token lapses. The connector
  tolerates a missing refresh token. (Only github.com endpoints are wired here.)
- **Revocation on disconnect** deletes the current *access token* via
  `DELETE /applications/{client_id}/token` (best-effort; the local connection is disabled
  regardless). It does not delete the authorization *grant* (`.../grant`), so a still-valid
  refresh token may persist on GitHub's side until the user revokes app access. The stored
  credential is disabled locally either way, so it can no longer be used from this platform.
- **Refresh crash window**: if the process crashes after GitHub rotates the refresh token
  but before the compare-and-swap persists it, the stored refresh token is stale and the
  connection must be re-authorized. This is inherent to rotation without holding a DB
  transaction across the network call (which the architecture forbids).

