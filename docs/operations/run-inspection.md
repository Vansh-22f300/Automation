# Run inspection — confirming a run (API + CLI)

A read-only, tenant-scoped view of one workflow run, served two ways from the **same**
safe DTO (one assembler, one redaction policy — the surfaces cannot drift):

- **HTTP:** `GET /v1/runs/:runId` and `GET /v1/runs` (authenticated, tenant-scoped).
- **CLI:** `pnpm runs:inspect <tenantId> <runId> [--detail]` (operator/dev aid).

Both return the run plus its steps, jobs, LLM usage, inferred tool activity, and — the
subject of this guide — the **durable tool-effect summary**: the authoritative record
of the external tool calls a run actually made.

## Inferred tool rounds are NOT actual tool calls

Two different things describe tool use. Do not confuse them:

- **`tools[]` (inferred).** Reconstructed from `llm_usage` round counts: a step with more
  than one metered round used tools, and `toolRounds = rounds - 1`. This is derived
  telemetry, **not** a tool-call count — one round can issue several calls, so it
  under-counts, and it exists only because each provider round is metered separately.
- **`toolEffects[]` (durable, authoritative).** One row per external tool call, from the
  effect ledger (`tool_effects`). This is where "a tool call actually happened" must come
  from. Each call is keyed by a per-step `ordinal`, so repeated calls to the same tool in
  one step are distinct rows — something the inferred count cannot represent.

When you need evidence that a tool ran, read `toolEffects`, never `tools.toolRounds`.

## What the tool-effect summary contains (and never contains)

Each `toolEffects[]` entry carries only safe metadata:

| field       | meaning                                                            |
|-------------|--------------------------------------------------------------------|
| `stepKey`   | the step that issued the call                                      |
| `toolName`  | e.g. `github_get_authenticated_user`                               |
| `ordinal`   | per-step index of the call across rounds (disambiguates repeats)   |
| `provider`  | stable connector id, e.g. `github`, `slack`                        |
| `state`     | `pending` \| `succeeded` \| `failed` \| `ambiguous`                |
| `ambiguous` | `true` iff `state === 'ambiguous'` (crash-triage signal)           |
| `error`     | sanitized `{ code, message }` for a failed/ambiguous call, else `null` |

It **never** carries raw tool results, tool arguments, prompts, credentials/bearer tokens,
idempotency keys, lease timestamps, owner tokens, or an unredacted error (`details` is
dropped and the message is secret-scrubbed). `ambiguous` means the outcome is unknown and
was deliberately **not** auto-resent — reconcile it by hand.

## Confirming the GitHub read-only pilot

For the pilot's proven production run (`status: succeeded`, step `whoami`,
`github_get_authenticated_user` succeeded, two LLM rounds):

### CLI

```bash
pnpm runs:inspect <tenantId> <runId>
```

The default output (no `--detail`) now includes the durable record:

```
external tool effects (1) — actual durable tool calls (effect ledger), execution order:
  step=whoami  tool=github_get_authenticated_user  #1  github  state=succeeded
```

`--detail` adds the secret-scrubbed raw context/payload/step I/O; it does **not** change
the tool-effect summary (that is identical on both surfaces).

### API

```bash
curl -s https://<api-host>/v1/runs/<runId> \
  -H "Authorization: Bearer <tenant-api-key>"
```

The 200 body includes (abridged):

```json
{
  "run": { "status": "succeeded", "currentStepKey": "whoami" },
  "tools": [{ "stepKey": "whoami", "rounds": 2, "usedTools": true, "toolRounds": 1 }],
  "toolEffects": [{
    "stepKey": "whoami",
    "toolName": "github_get_authenticated_user",
    "ordinal": 1,
    "provider": "github",
    "state": "succeeded",
    "ambiguous": false,
    "error": null
  }]
}
```

`toolRounds: 1` is the **inferred** figure; the single `toolEffects` row is the
**authoritative** evidence the GitHub call executed. The connected account login appears
only in the step's own output (summarized on this surface, raw via CLI `--detail`), never
in the tool-effect summary.

## Security model

- **Authentication & tenant isolation are unchanged.** The tenant comes from the API key,
  never the URL. A run that is absent **or** owned by another tenant returns the **same**
  `404` — a tenant cannot probe for another tenant's runs, and cannot read another tenant's
  effects.
- **Summary-only over HTTP.** The API never attaches raw context/payload/output; there is
  no `--detail` mode on HTTP. Raw scrubbed values are a CLI-only aid.
- **The effect projection is safe in every mode.** Because it carries no sensitive field,
  it is served on the summary surface without a detail gate.
- **No credentials or live calls are needed to confirm a run** — inspection reads only
  stored rows. The automated tests use seeded rows and a fake provider; they make no
  production API call and use no production credentials.
