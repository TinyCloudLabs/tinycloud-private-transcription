# ptx-batch runbook

`ptx-batch` is the dedicated batch-transcription CVM (`PTX_ROLE=batch`; contract in [SPEC.md](../../SPEC.md#batch-transcription-ptx_rolebatch)).
It runs `api`, `upload-worker` and Postgres from [`app-compose.yaml`](./app-compose.yaml): no Vexa, Redis, Signal,
Whisper or docker.sock. It is a separate CVM with its own Tinfoil credential; **ptx-dev (the live meeting service) is
never touched by anything here.**

Deploys run only through the manual workflow [`deploy-batch.yml`](../../.github/workflows/deploy-batch.yml). Merging
changes to this directory or that workflow deploys nothing, and no image is built for them.

## Owner prerequisites (once)

1. **Phala access.** Run `phala login` (workspace "Tiny Cloud", profile `tinycloudxyz`), then create a Phala API key and
   store it: `gh secret set PHALA_CLOUD_API_KEY --env ptx-batch -R TinyCloudLabs/tinycloud-private-transcription`.
2. **A dedicated batch Tinfoil key** with its own quota (never ptx-dev's key). State its rate limit.
   `gh secret set BATCH_TINFOIL_API_KEY --env ptx-batch -R TinyCloudLabs/tinycloud-private-transcription`.
3. **Accept the cost.** tdx.large, 40 GB disk: about $0.232/h ≈ $170/month at the August rate (check with
   `phala instance-types`).
4. Recommended: add yourself as a required reviewer on the `ptx-batch` GitHub Environment, so every dispatch waits
   for approval.

## Setup (once, after the owner prerequisites)

```bash
R=TinyCloudLabs/tinycloud-private-transcription
# Postgres password (never leaves the sealed env). Hex only: it is interpolated into DATABASE_URL, where base64's
# '/' or '+' would break the URI; the workflow refuses anything but 32+ URI-unreserved characters.
openssl rand -hex 32 | tr -d '\n' | gh secret set BATCH_POSTGRES_PASSWORD --env ptx-batch -R $R
# API keys: prints each plaintext key once plus the hashed PTX_BOOTSTRAP_KEYS line.
bun run scripts/mint-bootstrap-keys.ts --key 'tinychat-batch:tinychat:transcriptions:*' --key 'owner-admin:ops:admin:*'
gh secret set PTX_BOOTSTRAP_KEYS  --env ptx-batch -R $R   # paste the JSON after "PTX_BOOTSTRAP_KEYS="
gh secret set PTX_BATCH_ADMIN_KEY --env ptx-batch -R $R   # paste the owner-admin plaintext key (drain/open)
# Every deploy refuses to start unless PTX_BATCH_ADMIN_KEY hashes to the admin:* entry of PTX_BOOTSTRAP_KEYS.
# The tinychat-batch plaintext key is TinyChat's PRIVATE_CLOUD_TRANSCRIPTION_API_KEY (P4); store it there only.
```

## Pin the image

The compose pins the api/worker image immutably. Until the first batch image exists it holds a placeholder
(`api:PIN_AFTER_P2_MERGE@sha256:000…`), and the workflow refuses to deploy it. After the batch code is on `main`,
`publish-image.yml` publishes `ghcr.io/tinycloudlabs/tinycloud-private-transcription/api:<main sha>`; take the digest from
that run's summary and open a PR that sets both `image:` lines to `api:<sha>@sha256:<digest>`. The workflow checks that
`<sha>` is on `main` and that GHCR maps the tag to exactly that digest. Every later image change is the same one-line PR.

The first creation needs an image that contains migration 0018 (a fresh install starts with admission `closed`); the
workflow refuses a pin whose commit lacks `src/db/migrations/0018_batch_admission_closed.sql`, because an older image
seeds admission `open`. The order is: merge the change to `main` → `publish-image.yml` publishes that commit's image →
re-pin PR (both `image:` lines) merged → dispatch the create.

## Deploy

```bash
gh workflow run deploy-batch.yml -R $R --ref main -f confirm=ptx-batch
```

- **Tooling.** Bun is pinned, every action is SHA-pinned, and the repo's dependencies plus the Phala CLI/SDK
  ([`.github/scripts/package-lock.json`](../../.github/scripts/package-lock.json)) are installed with lifecycle scripts
  disabled before any secret is in scope. Bump the CLI by editing that `package.json` and regenerating the lockfile
  (`npm install --package-lock-only --ignore-scripts`).
- **First creation** (`PTX_BATCH_CVM_ID` unset): `phala deploy -n ptx-batch -t tdx.large --disk-size 40G
  --no-dev-os --no-public-logs --wait`, then a health gate, then an admission gate: a fresh install starts with
  admission `closed` (migration 0018) and must report `closed` to the admin key before `{"mode":"open"}`. A failed
  create leaves admission closed. Record the CVM id it prints:
  `gh variable set PTX_BATCH_CVM_ID --env ptx-batch -R $R --body <id>`.
- **Update**: `PUT /v1/admin/admission {"mode":"drain"}` → wait until `awaiting_upload + queued + processing = 0` →
  `phala deploy --cvm-id … --wait` → allowed_envs sync → health gate (`/health/live`, then
  `checks.upload_transcription.ready`) → admission gate (reports `drain`) → `{"mode":"open"}`. A drain response without
  three non-negative integer counts fails the run (never read as drained).
- **Sizing `drain_timeout_minutes`** (1–300, default 130): an accepted create may upload for up to 120 min, then jobs
  process one at a time, each bounded by the 240-min processing ceiling but typically far shorter. The worst case is
  `120 + (awaiting_upload + queued + processing) × 240` minutes; the run prints it at drain start and warns when the
  timeout is below it. Check the queue first (`GET /v1/admin/admission`) and size to what you see; with a deep queue,
  drain ahead of time (`PUT … {"mode":"drain"}`) and dispatch once `active` is 0.
- A failure after the drain leaves admission in **drain**. Investigate, then reopen deliberately:
  `curl -X PUT $URL/v1/admin/admission -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"mode":"open"}'`.

`$URL` is `https://<app_id>-8080.<gateway base domain>` (printed in the workflow summary). It becomes Exo's compiled-in
PTX upload origin (P7) and TinyChat's `PRIVATE_CLOUD_TRANSCRIPTION_API_URL`.

## Browser uploads (CORS)

Exo uploads the recording straight from the browser/app to `PUT /uploads/{id}`, so the service must allow those
origins with `BATCH_CORS_ORIGINS` (contract: [SPEC.md](../../SPEC.md#upload)). It is not a secret and is not yet set in
[`app-compose.yaml`](./app-compose.yaml); adding it to the `api` service's `environment:` is a deploy change (TC-596).
Recommended value:

```
https://tinycloud.chat,https://*.tinychat-4jq.pages.dev,tauri://localhost,http://tauri.localhost,capacitor://localhost,https://localhost
```

Check after a deploy: `curl -si -X OPTIONS $URL/uploads/trn_01M3PQ71Q9YF7GSEFP6S19ZJPW -H 'Origin: https://tinycloud.chat'
-H 'Access-Control-Request-Method: PUT'` answers `204` with `access-control-allow-origin: https://tinycloud.chat`.

## Verify (plan V3)

- `GET /health` → `checks.upload_transcription`: `ready: true`, `provider_configured: true`, `worker_live: true`,
  `retention_lag_seconds: 0`.
- The CVM runs the production OS: `phala cvms get ptx-batch --json` shows no dev OS, and `phala ssh ptx-batch` has no
  access. Only after this is confirmed may the Exo copy say "without SSH access".
- Key scopes: the `tinychat-batch` key gets 200 on `GET /v1/transcriptions/capabilities` and 403 on `/v1/admin/admission`;
  the admin key gets the reverse; no meetings-scoped key exists.
- End-to-end with `short` and `dense60` fixtures: record upload throughput through the gateway, and check that
  `retention.audio_deleted_at` is set on every finished job.

## Kill switches

| Speed | Action |
|---|---|
| instant | `PUT /v1/admin/admission {"mode":"closed"}`: no creates, no uploads, no new claims (an in-flight job finishes) |
| instant | `{"mode":"drain"}`: no creates; accepted work continues |
| minutes | TinyChat `PRIVATE_CLOUD_TRANSCRIPTION_ENABLED=false` + its backend deploy |
| hard | `phala cvms stop ptx-batch` |

## Rollback

Drain, then open a PR that sets the previous image pin, merge it, and dispatch. Migration 0017 only adds tables and 0018
only changes the admission default (and closes a fresh install's seed row), so an older batch image runs against the
newer schema. **Never purge the volumes** while any job has
`deletion_state='pending'` or is still active: the deletion ledger lives in that Postgres and reconciles on the next
boot (the sweeper retries pending deletions and removes unauthorized files).

## Monitoring

- `/health` is `degraded` (503) when the worker is not live, the provider key is missing, the upload volume is at or above
  80%, or `retention_lag_seconds` exceeds 300. Logs are content-free JSON; `alert: true` marks operator faults (provider
  401/403/404, failed unlink, artifact reappearing after verified deletion, disk high-water, retention lag).
- Logs are not public (`--no-public-logs`): `phala logs ptx-batch -f`, `phala logs ptx-batch --serial --tail 200`.
