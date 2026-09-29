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
# Postgres password (never leaves the sealed env).
openssl rand -base64 32 | tr -d '\n' | gh secret set BATCH_POSTGRES_PASSWORD --env ptx-batch -R $R
# API keys: prints each plaintext key once plus the hashed PTX_BOOTSTRAP_KEYS line.
bun run scripts/mint-bootstrap-keys.ts --key 'tinychat-batch:tinychat:transcriptions:*' --key 'owner-admin:ops:admin:*'
gh secret set PTX_BOOTSTRAP_KEYS  --env ptx-batch -R $R   # paste the JSON after "PTX_BOOTSTRAP_KEYS="
gh secret set PTX_BATCH_ADMIN_KEY --env ptx-batch -R $R   # paste the owner-admin plaintext key (drain/open)
# The tinychat-batch plaintext key is TinyChat's PRIVATE_CLOUD_TRANSCRIPTION_API_KEY (P4); store it there only.
```

## Pin the image

The compose pins the api/worker image immutably. Until the first batch image exists it holds a placeholder
(`api:PIN_AFTER_P2_MERGE@sha256:000…`), and the workflow refuses to deploy it. After the batch code is on `main`,
`publish-image.yml` publishes `ghcr.io/tinycloudlabs/tinycloud-private-transcription/api:<main sha>`; take the digest from
that run's summary and open a PR that sets both `image:` lines to `api:<sha>@sha256:<digest>`. The workflow checks that
`<sha>` is on `main` and that GHCR maps the tag to exactly that digest. Every later image change is the same one-line PR.

## Deploy

```bash
gh workflow run deploy-batch.yml -R $R --ref main -f confirm=ptx-batch
```

- **First creation** (`PTX_BATCH_CVM_ID` unset): `phala deploy -n ptx-batch -t tdx.large --disk-size 40G
  --no-dev-os --no-public-logs --wait`, then a health gate. Record the CVM id it prints:
  `gh variable set PTX_BATCH_CVM_ID --env ptx-batch -R $R --body <id>`.
- **Update**: `PUT /v1/admin/admission {"mode":"drain"}` → wait until `awaiting_upload + queued + processing = 0` (default
  130 min, which covers the 2 h upload deadline) → `phala deploy --cvm-id … --wait` → allowed_envs sync → health gate
  (`/health/live`, then `checks.upload_transcription.ready`) → `{"mode":"open"}`.
- A failure after the drain leaves admission in **drain**. Investigate, then reopen deliberately:
  `curl -X PUT $URL/v1/admin/admission -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"mode":"open"}'`.

`$URL` is `https://<app_id>-8080.<gateway base domain>` (printed in the workflow summary). It becomes Exo's compiled-in
PTX upload origin (P7) and TinyChat's `PRIVATE_CLOUD_TRANSCRIPTION_API_URL`.

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

Drain, then open a PR that sets the previous image pin, merge it, and dispatch. Migration 0017 only adds tables, so an
older batch image runs against the newer schema. **Never purge the volumes** while any job has
`deletion_state='pending'` or is still active: the deletion ledger lives in that Postgres and reconciles on the next
boot (the sweeper retries pending deletions and removes unauthorized files).

## Monitoring

- `/health` is `degraded` (503) when the worker is not live, the provider key is missing, the upload volume is at or above
  80%, or `retention_lag_seconds` exceeds 300. Logs are content-free JSON; `alert: true` marks operator faults (provider
  401/403/404, failed unlink, artifact reappearing after verified deletion, disk high-water, retention lag).
- Logs are not public (`--no-public-logs`): `phala logs ptx-batch -f`, `phala logs ptx-batch --serial --tail 200`.
