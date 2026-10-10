# Temporary $0 deployment (development / demo)

> **This is temporary development/demo infrastructure. It is NOT the final
> production architecture.** It exists to stand the app up for free while
> developing or demoing. The production deployment is the Render Blueprint in
> [`render.yaml`](../render.yaml) (always-on API + always-on background worker +
> managed Postgres); this free mode intentionally trades latency and always-on
> guarantees for $0. When you are ready for production, use `render.yaml` and turn
> this free mode off (see [Switching back to the paid always-on
> architecture](#switching-back-to-the-paid-always-on-architecture)).

Free mode keeps the real application unchanged. Same Fastify API, same durable
PostgreSQL queue, same worker (`src/worker/main.ts`) with its leases, retries and
dead-letter behaviour. Nothing about queue semantics, the schema, migrations or
retention changes. Only two things differ from production:

- the **API** runs on a **Render Free Web Service** instead of a paid instance;
- the **worker** runs as **short, scheduled GitHub Actions sessions** instead of
  an always-on Render background worker (Render Free has no background workers).

## Topology

| Component | Production (`render.yaml`) | Free mode (this doc) |
|---|---|---|
| API | Render paid web service | Render **Free** web service |
| Worker | Render paid background worker (always on) | **GitHub Actions** scheduled sessions (`.github/workflows/worker-free.yml`) |
| Database | Render managed Postgres | **Neon Free** Postgres (unchanged from dev) |
| Migrations | API `preDeployCommand` | **One-time, manual** (free tier has no `preDeployCommand`) |
| Frontend | Vercel (later) | **Not deployed yet** |

## Prerequisites

### Public GitHub repository (required)

The scheduled worker only stays $0 because this repository is **public**.
GitHub Actions minutes are **unlimited on standard runners for public repos**. On
a **private** repo the Free plan includes only **2,000 minutes/month**, and a
5-minute cadence (~8,760 runs/month, plus checkout/install/build per run) blows
through that in a few days and then bills real money. If this repo is ever made
private again, **the 5-minute schedule is no longer free** — raise the cron
interval or move the worker back to the paid Render service.

## Render Free Web Service (API)

Render Free supports **web services**, static sites, Postgres and Key Value only —
**no background workers, no cron jobs**. So only the API goes on Render; the worker
goes to GitHub Actions.

### Free tier limitations you must expect

- **Sleeps after 15 minutes** with no inbound traffic. The first request after
  that pays a **cold start of ~1 minute** while the instance spins back up (a
  loading page is shown to browsers meanwhile). This is normal and expected for a
  demo — it is not a bug. An optional best-effort keep-alive can reduce how often
  this happens — see [Keep-alive for the Render Free API](#keep-alive-for-the-render-free-api-best-effort).
- 750 free instance-hours/month per workspace (a single sleepy demo fits easily),
  single instance only, **no shell/SSH**, **no persistent disk**, and **no
  `preDeployCommand`** (which is why migrations are run manually — see below).

### Dashboard setup (do not create a second `render.yaml`)

Set the API up **manually in the Render dashboard**. Do **not** point a Blueprint
at `render.yaml` for free mode — that file describes the paid production topology
(worker + managed Postgres) and must stay intact for later. A Blueprint also only
reads a file literally named `render.yaml`, so there is nothing to duplicate:
free mode is dashboard state, not a repo file.

1. **New > Web Service**, connect this repository, pick the branch (e.g. `main`).
2. **Instance type: Free.**
3. **Runtime:** Node.
4. **Build command:**
   ```
   corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm build
   ```
   `--prod=false` is required: `NODE_ENV=production` (below) would otherwise make
   pnpm skip devDependencies, but the build needs `tsc` + `tsc-alias` to emit
   `dist/`.
5. **Start command:**
   ```
   node dist/api/server.js
   ```
6. **Health check path:** `/readyz` (returns 200 only when the process can reach
   Postgres; `/healthz` is liveness-only and is the wrong gate for routing).
7. Add the environment variables below.

### API environment variables (Render)

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | |
| `HOST` | `0.0.0.0` | Production refuses a loopback host at boot. |
| `PORT` | *(leave unset)* | **Render injects `PORT` automatically**; the app reads it. Do not hard-code it. |
| `DATABASE_URL` | Neon **pooled** connection string, ending `?sslmode=require` | Non-loopback and the db name must not contain `test`, or boot is refused. |
| `CREDENTIAL_ENCRYPTION_KEY` | a generated 32-byte key | **Required at boot.** **Must be byte-identical to the worker's** GitHub secret. |
| `APP_ORIGIN` | your **Vercel frontend** URL, e.g. `https://<your-app>.vercel.app` | **Required in production** (https, non-loopback, or boot is refused). The public **frontend** origin emailed verification/reset links point at — the BFF `/backend/auth/*` routes — **not** this Render API host. |
| `TRUST_PROXY` | `true` | Render's proxy is the sole ingress; this makes the per-IP rate limiter key on the real client IP from `X-Forwarded-For` rather than the proxy's IP. |
| `DATABASE_POOL_MAX` | `5` | Neon Free caps connections; the API shares that ceiling with overlapping worker sessions. |
| `LOG_LEVEL` | `info` | Optional; omit to accept the default. |
| `ANTHROPIC_API_KEY` **or** `ANTHROPIC_AUTH_TOKEN` | your key/token | **Only if** exercising LLM steps. Mutually exclusive — set at most one. |
| `EMAIL_TRANSPORT` | *(leave unset)* → `log` | **Only if** sending real email. Set `resend` to deliver via Resend; then `EMAIL_FROM` + `RESEND_API_KEY` are required or boot is refused. Left unset, signup/reset work but send no mail. |
| `EMAIL_FROM` | `AI Workforce <noreply@your-verified-domain>` | **Only with** `EMAIL_TRANSPORT=resend`. `Display Name <addr>` is accepted; the address must be on a Resend-verified sending domain. |
| `RESEND_API_KEY` | your Resend key | **Only with** `EMAIL_TRANSPORT=resend`. **Secret, server-only** — never exposed to the browser/Nuxt public runtime. |
| `CREDENTIAL_ENCRYPTION_KEYS` | *(leave unset)* → single-key v1 | **Optional; enables v2 (AAD-bound) encryption.** Multi-key keyring `<active-kid>:<base64-32B>,legacy-v1:<base64-32B>` whose `legacy-v1` entry MUST carry the current `CREDENTIAL_ENCRYPTION_KEY` bytes. **Must be byte-identical to the worker's.** Secret, server-only. See [Enabling v2 credential encryption and GitHub OAuth](#enabling-v2-credential-encryption-and-github-oauth). |
| `GITHUB_CLIENT_ID` | *(leave unset)* → GitHub disabled | **Optional.** GitHub OAuth App client id (not a secret, but deployment-specific). **Both-or-neither** with `GITHUB_CLIENT_SECRET`. |
| `GITHUB_CLIENT_SECRET` | your GitHub OAuth App client secret | **Optional; both-or-neither** with `GITHUB_CLIENT_ID`. **Secret, server-only.** Needed on the API (authorize/callback/revoke) **and** the worker (token refresh). |

Generate the encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Keep the exact output. You will paste the **same** value into the worker's
`CREDENTIAL_ENCRYPTION_KEY` GitHub secret.

**Email delivery (optional).** In free/demo mode you can leave `EMAIL_TRANSPORT`
unset: signup and password reset work, but no email is actually sent (the
`log` transport records metadata only). To deliver real messages, verify a
sending domain in Resend, then set `EMAIL_TRANSPORT=resend`, `EMAIL_FROM` (an
address on that verified domain), and `RESEND_API_KEY` on the **API service**
only (the worker sends no mail). `RESEND_API_KEY` is a secret — set it in the
dashboard, never in the repo. The verification/reset links are built from
`APP_ORIGIN` (the Vercel frontend URL above), so they land on the frontend BFF,
not on this Render API host.

## Database (Neon — unchanged)

Keep Neon. **Do not create a Render Postgres instance.** Both the API (Render env)
and the worker (GitHub secret) point `DATABASE_URL` at the **same** Neon database.

- Use Neon's **pooled** endpoint (the host containing `-pooler`) and append
  `?sslmode=require`. Pooling matters because the API and an overlapping worker
  session open connections concurrently against Neon Free's tight connection cap.
- The db name must **not** contain `test` (the production env guard rejects it).
- Neon Free autosuspends when idle and wakes in a few seconds on the next query;
  that wake can stack with Render's cold start on the first request after a quiet
  period. Expected in free mode.
- **Recommendation:** use a **dedicated demo database or Neon branch** and a
  **fresh demo `CREDENTIAL_ENCRYPTION_KEY`** — not production data and not a
  production key. Rotate/delete both when you tear the demo down.

### Migration procedure (one-time, and on new migrations)

Free tier has **no `preDeployCommand` and no shell**, so migrations are run
**out of band, from your machine**, against Neon. The migration tree in
`drizzle/` is unchanged and immutable; the runner (`src/db/migrate.ts`) applies
every pending file in a transaction and is safe to re-run (already-applied
migrations are skipped).

**Do not** put migrations in the Render **start** command — that would re-run on
every cold-start spin-up and let concurrent boots race. Run them explicitly
instead.

One-time, before the first deploy — and again whenever a new migration is added
to `drizzle/`:

```bash
DATABASE_URL='<your Neon pooled URL>?sslmode=require' pnpm db:migrate
```

Then deploy/redeploy the Render API. Because you migrate first and the worker
never migrates, the API and worker never race to apply the same migration.

> Alternative (hands-off): fold `&& node dist/db/migrate.js` onto the end of the
> Render **build** command so each deploy migrates before going live. Simpler to
> operate, but couples migrations to build-time and to the build's `DATABASE_URL`.
> The manual step above is the recommended default for a demo.

## Worker (GitHub Actions, 5-minute sessions)

The worker runs as [`.github/workflows/worker-free.yml`](../.github/workflows/worker-free.yml):
`schedule` every 5 minutes plus manual `workflow_dispatch`. Each run installs,
builds, then runs **one bounded session** of the existing worker:

```
timeout --signal=SIGTERM --kill-after=30s --preserve-status 240s \
  node dist/worker/main.js
```

- At **240s (~4 min)** `timeout` sends **SIGTERM**; the worker stops claiming,
  drains the in-flight job, **hands its lease back to `pending`**, closes the
  pool, and exits **0**.
- `--kill-after=30s` sends **SIGKILL** only if graceful shutdown wedges (a real
  red signal, not silent loss).
- `--preserve-status` reports the **worker's** real exit code, so a clean drain
  is a green run.
- The workflow **does not run migrations** (see above).

### Why overlapping sessions are safe

If one session overruns into the next, both talk to the same `jobs` table.
Claims use `FOR UPDATE SKIP LOCKED` and every settlement is guarded on
`locked_by`, so two concurrent sessions **cannot double-process** a row. That is
why the workflow uses `concurrency: worker-free` with **`cancel-in-progress:
false`** — an overrunning session is allowed to finish draining rather than being
hard-killed (a hard kill would strand its job's lease until the 15-minute lease
lapses and a later session's reaper reclaims it).

### Expected worker latency

Free mode is a **batch/polling** model, not real-time:

- **While a session is running:** a newly-ready job is claimed within ~1 second.
- **Between sessions:** a job that becomes ready just after a window closes waits
  for the next session. With a 5-minute cron and a ~4-minute window that is a
  ~1–5 minute gap, **plus** GitHub's own scheduled-run delay (scheduled workflows
  are best-effort and can be delayed or dropped under load). Treat realistic
  worst-case pickup as **~5–15 minutes**.
- **Retries** are deferred to a future `run_at` by the backoff policy and are only
  re-claimed by a session running at/after that time, so they snap to the next
  session boundary too.

If you need low, predictable latency, that is what the paid always-on worker is
for — switch back (below).

### Keep-alive for the Render Free API (best-effort)

Render Free spins the API down after ~15 minutes without inbound traffic (see
[Free tier limitations](#free-tier-limitations-you-must-expect)). The worker
workflow already runs about every 5 minutes, so it can **piggyback** a single
lightweight request to keep the API warm — no second workflow and no extra
schedule.

The keep-alive step in [`worker-free.yml`](../.github/workflows/worker-free.yml):

- runs **only when the `RENDER_API_URL` Actions variable is set**; with no URL
  configured it logs `skipped` and succeeds (no Render URL is hard-coded in the
  repo);
- sends one unauthenticated `GET {RENDER_API_URL}/healthz` — the **public,
  DB-free** liveness endpoint. It never sends a credential, never hits `/v1/*`,
  and never uses `/readyz` (which would open a Neon connection merely to keep
  Render warm);
- is **fail-safe**: a short-timeout `curl` whose failure is swallowed, run with
  `if: always()`, so it fires even if the worker session failed and its own
  result never fails the job. It logs whether it was attempted or skipped and the
  HTTP status, never any secret.

**Set the URL** under **Settings → Secrets and variables → Actions → Variables**
(a repo variable, or an environment variable on the `worker-free` environment)
named `RENDER_API_URL`, value `https://<your-api-name>.onrender.com` (no trailing
`/healthz` — the step appends it). It is a plain **variable, not a secret**: the
API base URL is not sensitive and `/healthz` needs no auth.

> **Best-effort, not a guarantee.** GitHub scheduled workflows are best-effort and
> can be delayed or dropped, so a 15-minute window may occasionally be missed and
> the service can still sleep. If you need a reliable warm-up with no repo change,
> point an **external uptime monitor** (e.g. UptimeRobot or cron-job.org) at
> `https://<your-api-name>.onrender.com/healthz` on a sub-15-minute interval — it
> runs entirely outside GitHub Actions, costs zero runner minutes, and needs no
> workflow edit. Or switch to the paid always-on service (below), which never
> sleeps.

### Secret setup (GitHub Environment `worker-free`)

The worker needs two secrets, scoped to a GitHub **Environment** named
`worker-free` so that CI (`ci.yml`) and pull-request runs cannot read them:

1. Repo **Settings > Environments > New environment** → name it `worker-free`.
   Optionally add required reviewers / branch restrictions for extra protection.
2. Add these **environment secrets** (never repo-wide, never hard-coded, never
   echoed in a step):

   | Secret | Value |
   |---|---|
   | `DATABASE_URL` | the **same** Neon pooled URL (`...?sslmode=require`) the API uses |
   | `CREDENTIAL_ENCRYPTION_KEY` | the **same** key configured for the API on Render — a mismatch makes every stored connection credential unreadable on one side |
   | `CREDENTIAL_ENCRYPTION_KEYS` *(optional)* | the **same** keyring value as the API — enables v2 (AAD-bound) encryption; must be byte-identical to the API's, because the worker decrypts v2 rows the API wrote. Leave unset to keep single-key v1. |
   | `OAUTH_GH_CLIENT_SECRET` *(optional)* | the GitHub OAuth App client secret — the worker needs it for token refresh. **Both-or-neither** with `OAUTH_GH_CLIENT_ID` (an environment **variable**, below). |

   `OAUTH_GH_CLIENT_ID` is **not** a secret — add it as a `worker-free` environment
   **variable** (Settings > Environments > worker-free > Variables), not a secret.
   **Why these names:** GitHub Actions reserves the `GITHUB_` prefix for secret/variable
   names, so the Actions environment uses `OAUTH_GH_CLIENT_ID` / `OAUTH_GH_CLIENT_SECRET`;
   `worker-free.yml` forwards them to the application's `GITHUB_CLIENT_ID` /
   `GITHUB_CLIENT_SECRET` at runtime (the names used on Render and in a local `.env`).
   The two values are **both-or-neither**: the workflow fails the run with a clear,
   non-secret diagnostic if exactly one is set, so a half-configured provider never
   starts. All three optional values may be left unset — the worker then runs exactly as
   before (single-key v1, GitHub disabled).

Security notes:

- The workflow triggers on **`schedule` + `workflow_dispatch` only — never
  `pull_request`** — so fork PRs cannot run with these secrets.
- Secrets are masked in logs; do not add steps that echo environment variables.
- Because the repo is public, the **source is public** — but the secrets are not
  (they live in the environment, masked). Still, prefer **throwaway demo
  credentials** (a dedicated Neon database/branch and a fresh key), and rotate or
  delete them when the demo ends. Never let a demo key become a production key.
- `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are only needed if you actually
  test LLM steps; add whichever one as a `worker-free` secret and reference it in
  the workflow's `env` at that point. Free mode omits them by default.

## Enabling v2 credential encryption and GitHub OAuth

These are **optional** and **additive**. With all of them unset the stack runs
unchanged: a single `CREDENTIAL_ENCRYPTION_KEY` (v1 envelopes), Slack working as
before, and the GitHub provider simply unregistered. Turn them on in the order
below, **worker before API**, so the worker can always decrypt what the API writes.

### The keyring format (`CREDENTIAL_ENCRYPTION_KEYS`)

Comma-separated `<kid>:<base64-key>` entries:

```
<active-kid>:<base64-new-active-key>,legacy-v1:<base64-original-legacy-key>
```

- The **first** entry is the **active** key — new/rotated credentials are encrypted
  under it. Its kid matches `^[a-zA-Z0-9._-]{1,64}$` (e.g. a date like
  `2026-10-active`) and must **not** be `legacy-v1`.
- `legacy-v1` is **decrypt-only** (never the active/first entry) and lets existing
  v1 credentials keep decrypting.
- **Every key decodes to exactly 32 bytes** (AES-256) — base64 (or 64 hex chars) of
  a 32-byte key.
- **Preserve the original legacy key bytes.** The `legacy-v1` entry MUST carry the
  **same bytes** as your current `CREDENTIAL_ENCRYPTION_KEY`, or every existing (v1)
  connection becomes undecryptable.
- **If your current key is hexadecimal** (64 hex chars), convert its *decoded bytes*
  to base64 for the `legacy-v1` entry — do **not** generate a new key:

```bash
  # Convert the EXISTING hex key's bytes to base64. Run in a private shell; send the
  # output only to the secret store, never to logs or a PR.
  node -e "process.stdout.write(Buffer.from(process.env.OLD_HEX_KEY,'hex').toString('base64'))"
```

Generate the **new active** key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Never commit or paste real key values into this repo, a PR, a doc, or CI logs.

### Why order matters

The worker both **reads** credentials (to run tools) and **writes** them (on token
refresh). A v2 envelope carries the active `kid`; a process whose keyring lacks that
kid cannot decrypt it. So the worker must carry the new keyring **before** the API
writes any v2 row. Adding the active key is additive — the `legacy-v1` entry keeps
every existing v1 row readable throughout, so legacy connections never break.

### Rollout sequence

A. **Merge the worker-wiring PR first, with all new secrets/variables unset.** The
   workflow change is a no-op until configured.
B. **Prepare the new keyring securely, keeping the existing legacy key.** Build
   `CREDENTIAL_ENCRYPTION_KEYS` = `<active-kid>:<base64-new>,legacy-v1:<base64-existing-bytes>`.
   Keep `CREDENTIAL_ENCRYPTION_KEY` set for now (boot is refused if the legacy var is
   set but the keyring has no `legacy-v1` entry).
C. **Configure the worker's `CREDENTIAL_ENCRYPTION_KEYS` secret first** (GitHub
   `worker-free` environment). Do not touch the API yet.
D. **Confirm old-config worker runs have finished**, then **manually trigger**
   (`workflow_dispatch`) a run and verify it boots and drains cleanly. The config
   step logs `keyring: CREDENTIAL_ENCRYPTION_KEYS provided` (presence only).
E. **Only then** set the **identical** keyring on the Render Free API (dashboard) and
   let it restart. The API now writes v2; the worker already reads it.
F. **Verify both processes still decrypt existing legacy connections** — exercise a
   tool that uses a pre-v2 connection on each side; it resolves without a decryption
   error (the `legacy-v1` entry covers v1 rows).
G. **Configure the GitHub OAuth client together on API and worker**, only when ready to
   activate GitHub OAuth — setting one without the other fails fast. On **Render** (API)
   use `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`; on the **GitHub Actions `worker-free`**
   environment use `OAUTH_GH_CLIENT_ID` (variable) + `OAUTH_GH_CLIENT_SECRET` (secret),
   which the workflow forwards to the app's `GITHUB_CLIENT_*` names.
H. **Keep `APP_ORIGIN` on the public Vercel frontend** (API). Do not change auth link
   origins — the GitHub callback is reached via the BFF at `${APP_ORIGIN}/oauth/github/callback`.
   For the planned production frontend `https://ai-worke.vercel.app`, that is
   `https://ai-worke.vercel.app/oauth/github/callback` — the OAuth App's callback URL
   must match it byte-for-byte.
I. **Run the first real GitHub OAuth test only after** the connection flow and the
   GitHub OAuth App (with that exact callback URL) are configured.

### Verifying each phase without exposing secrets

- Presence, not values: the config step prints only `provided` / `not set` lines,
  and GitHub masks secret values in logs regardless.
- Boot health: a worker run that boots and drains (green, clean exit) proves the
  keyring parsed and the legacy key still decrypts. A bad keyring (e.g. missing
  `legacy-v1` while `CREDENTIAL_ENCRYPTION_KEY` is set) fails at boot with a typed,
  non-secret error.
- Both-or-neither GitHub: setting one value fails the run with `::error::OAUTH_GH_CLIENT_ID
  (variable) and OAUTH_GH_CLIENT_SECRET (secret) must be set together…` — no value printed.
- Legacy reads: confirm an existing connection still resolves after each step; a
  failure surfaces as a typed `credential_decryption_failed`, never a key value.
- Do not run `connections:rotate` or any live GitHub OAuth flow as a "test" before G/I.

### Manually verifying a connection decrypts (phase D / F)

A dedicated manual workflow, **"verify connection decrypt (manual)"**
([`.github/workflows/verify-connection-decrypt.yml`](../.github/workflows/verify-connection-decrypt.yml)),
proves one connection's stored credential decrypts under the configured keyring
**with no database write, no external (Slack/GitHub) call, and no key rotation** — it
reuses the rotation dry-run decrypt path. Use it at phase D (worker keyring) and
phase F (API keyring) to confirm, e.g., the existing legacy Slack connection decrypts.

**Get the two IDs (both UUIDs, neither secret).** The frontend Connections page shows
only a shortened connection ID and no tenant ID, so read both straight from the
database. In the **Neon Console → SQL Editor**, run this read-only metadata query:

```sql
SELECT id, tenant_id, provider, status FROM connections WHERE provider = 'slack';
```

Take the connection UUID from the `id` column and the tenant UUID from `tenant_id`.
Select **only** these non-secret metadata columns — never `SELECT *`, and never query,
read, or copy `encrypted_credentials` (or any other credential/secret column). The
verification does not need the ciphertext and it must never appear in the SQL Editor,
a screenshot, logs, or a ticket. The two UUIDs are internal identifiers, not secrets,
but keep them out of public issues, chats, and screenshots anyway. (If you already know
the tenant UUID, `pnpm connections list <tenantId>` prints the same non-secret
metadata — `<id> <provider>/<name> [status]` — and never a credential.)

**Run it:** GitHub → Actions → **verify connection decrypt (manual)** → **Run
workflow**, paste the tenant and connection UUIDs, run. (The two IDs show in the run
metadata — expected; they are not secrets. Never paste a key or token here.) It runs
in the `worker-free` environment, so it uses the same secrets as the worker.

**Read the result:** exactly one line is printed —
`RESULT: PASS — …` (found and decrypted) or `RESULT: FAIL — …` (did not decrypt, or
the connection was not found / already current). A **PASS requires an actual decrypt**:
a missing or already-rotated connection reports FAIL, never a false pass. No
credential, key, DB URL, envelope, or connection name is ever printed.

## Frontend

**Not deployed in free mode yet.** The Nuxt app is an SPA (`ssr: false`) with a
**Nitro BFF**: the browser only ever calls the same-origin path
`NUXT_PUBLIC_API_BASE` (default `/backend`), and the Nitro server route at
`frontend/server/routes/backend/[...path].ts` forwards each GET/HEAD to Fastify
with a **server-only** `Authorization: Bearer <NUXT_API_KEY>`. The API key is
never shipped to the browser.

The frontend deploys to **Vercel**: set **Root Directory** to `frontend`, use the
**Nuxt.js** framework preset, and leave the build defaults — Nitro auto-detects
Vercel's `vercel` preset and runs the BFF as serverless functions, so **no
`vercel.json` is required**. Any host that runs the Nitro server works; a
static-only host does not (it has no BFF). `.output/` is local, gitignored build
output — Vercel builds its own artifact. Set these (names only — never commit the
values):

```
NUXT_API_KEY=<the Fastify tenant API key>              # server-only, never public
NUXT_BACKEND_URL=https://<your-api-name>.onrender.com  # server-only upstream (the Render API)
NUXT_BFF_TIMEOUT_MS=10000                              # server-only, optional (BFF upstream timeout)
NUXT_PUBLIC_API_BASE=/backend                          # public: same-origin browser path
```

Because the browser talks only to the same-origin BFF and the BFF reaches
Fastify server-to-server, **no CORS layer on the API is required** (and none
ships). The deploy target must execute the Nitro server; a static-only export
would have no BFF and is unsupported.

## First-deploy checklist

1. Confirm the repository is **public**.
2. Create the Neon **demo** database/branch; copy its **pooled** URL and append
   `?sslmode=require`.
3. Generate a fresh `CREDENTIAL_ENCRYPTION_KEY`.
4. Run the **one-time migration** from your machine (see above).
5. Create the Render **Free web service** manually; set the build/start commands,
   `/readyz` health check, and the API env vars (including the **same**
   `CREDENTIAL_ENCRYPTION_KEY`).
6. Create the GitHub **`worker-free` environment** and add the `DATABASE_URL` and
   `CREDENTIAL_ENCRYPTION_KEY` secrets (same values).
7. Trigger the worker once via **workflow_dispatch** to confirm it boots, drains,
   and exits cleanly; thereafter it runs every 5 minutes.

## Switching back to the paid always-on architecture

Free mode changes **no application code** and **no `render.yaml`**, so reverting is
purely operational:

1. Deploy the production Blueprint from [`render.yaml`](../render.yaml) (paid API +
   **always-on background worker** + managed Postgres), or upgrade the free API
   instance to a paid type and add the worker service. Set the same
   `CREDENTIAL_ENCRYPTION_KEY` across API and worker there.
2. **Disable the free-mode worker** so two workers don't both run: in the GitHub
   UI disable the **worker (free mode)** workflow, or delete
   `.github/workflows/worker-free.yml`. (Both are safe against the always-on
   worker anyway — the same SKIP LOCKED / lease guards apply — but running the
   scheduled sessions once production is live just wastes runner minutes.)
3. If you migrated the demo to Render Postgres or a production Neon database,
   point `DATABASE_URL` there and run migrations against it once.
4. Optionally remove the `worker-free` GitHub environment and its demo secrets.

No schema, migration, queue or retention change is involved in either direction.
