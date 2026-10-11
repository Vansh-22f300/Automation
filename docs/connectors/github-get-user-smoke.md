# GitHub connection smoke test (`github:get-user-smoke`)

A minimal, operator-run diagnostic that verifies a stored GitHub connection actually
works, by running exactly one read-only tool — `github_get_authenticated_user`
(`GET https://api.github.com/user`) — through the **real** worker execution path.

It answers one question: *does this tenant's stored GitHub credential still resolve,
decrypt, and authenticate against GitHub?* It is a connection check, **not** proof that
the scheduled worker has executed a GitHub workflow end to end.

## Command

```bash
pnpm github:get-user-smoke <tenantId> <connectionId>
```

Both ids must be UUIDs; they are validated before any database or network access, so a
typo cannot open a connection or reach production by accident.

## Expected output

A single sanitized line:

```
RESULT: PASS — login=<authenticated-account>
```

On failure, one line carrying a non-secret classification code, e.g.
`RESULT: FAIL [github_unauthorized] — …` or `RESULT: FAIL [oauth_provider_error] — …`.
No token, credential, ciphertext, connection string, or key material is ever printed.

## How it runs (parity with the worker)

It builds the **same** execution chain the worker uses for GitHub tool calls:
`ToolExecutor` → `RefreshingConnectionResolver` → `RefreshingTokenSource`
(`OAuthTokenClient` + OAuth provider registry) → `ConnectionRepository`
(`TenantScope` + `CredentialCipher`). Two deliberate narrowings:

- the tool registry holds **only** `github_get_authenticated_user` — `github_create_issue`
  is never registered, so the diagnostic cannot write to a repository; and
- **no effect ledger** is wired and no run/step ids are set, so no workflow, ledger, or
  job rows are created.

The connection is chosen by trusted `(tenantId, connectionId)` arguments — never a
browser- or model-supplied token.

## Required secure runtime configuration

Inject these in a trusted operator shell; never paste secrets into chat and avoid leaving
them in shell history. (`.env` is read if present.)

| Variable | Why |
| --- | --- |
| `DATABASE_URL` | The **original intended** production database. Never a recovery/clone branch. |
| `CREDENTIAL_ENCRYPTION_KEY` or `CREDENTIAL_ENCRYPTION_KEYS` | Decrypts the stored credential; must match the key the connection was sealed with. |
| `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` | Only needed if a token **refresh** fires (both-or-neither). |
| `NODE_ENV=production`, `HOST=0.0.0.0`, `APP_ORIGIN=https://…` | Production-compatible env so the shared boot invariants pass. |

## Expected side effects (a live run is NOT database-read-only)

- **Always:** `UPDATE connections SET last_used_at = now()` on the resolved row.
- **Conditionally:** if the stored access token is at/near expiry, the resolver refreshes
  it and persists the rotated credential via compare-and-swap, and GitHub rotates the
  refresh token.
- **GitHub requests:** normally a single `GET /user` (read). If the stored access token
  is expired or near expiry, the resolver first issues an **OAuth token-refresh request**
  to GitHub's token endpoint and then calls `GET /user` with the rotated token. **No**
  GitHub repository changes, issues, workflows, webhooks, jobs, LLM calls, Slack calls, or
  effect-ledger writes.

## Warnings

- Never paste secrets into chat or pass them as command arguments.
- Never run against a recovery/clone database branch — only the original intended DB.
- There are **no automatic retries**; a FAIL is reported once, sanitized.
- A PASS proves the connection resolves and authenticates. It does **not** prove the
  `worker-free` scheduled worker has run a GitHub workflow.
