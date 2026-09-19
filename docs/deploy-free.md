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
  demo — it is not a bug.
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
| `TRUST_PROXY` | `true` | Render's proxy is the sole ingress; this makes the per-IP rate limiter key on the real client IP from `X-Forwarded-For` rather than the proxy's IP. |
| `DATABASE_POOL_MAX` | `5` | Neon Free caps connections; the API shares that ceiling with overlapping worker sessions. |
| `LOG_LEVEL` | `info` | Optional; omit to accept the default. |
| `ANTHROPIC_API_KEY` **or** `ANTHROPIC_AUTH_TOKEN` | your key/token | **Only if** exercising LLM steps. Mutually exclusive — set at most one. |

Generate the encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Keep the exact output. You will paste the **same** value into the worker's
`CREDENTIAL_ENCRYPTION_KEY` GitHub secret.

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

## Frontend

**Not deployed in free mode yet.** When the Nuxt frontend is deployed later
(Vercel), it will need its API base pointed at the Render web service's **public
origin**, for example:

```
NUXT_PUBLIC_API_BASE=https://<your-api-name>.onrender.com
```

not the dev-only `/backend` Vite proxy path. Cross-origin browser calls will also
require addressing CORS on the API (it currently ships no CORS layer). That work
is out of scope for this free-mode setup.

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
