# ptx-batch runbook

`ptx-batch` is the dedicated batch-transcription CVM (`PTX_ROLE=batch`; contract in [SPEC.md](../../SPEC.md#batch-transcription-ptx_rolebatch)).
It runs `api`, `upload-worker`, Postgres and the `log-shipper` sidecar from [`app-compose.yaml`](./app-compose.yaml): no
Vexa, Redis, Signal, Whisper or docker.sock. It is a separate CVM with its own Tinfoil credential; **ptx-dev (the live meeting service) is
never touched by anything here.**

Deploys run only through the manual workflow [`deploy-batch.yml`](../../.github/workflows/deploy-batch.yml). Merging
changes to this directory or that workflow deploys nothing, and no image is built for them.

## Owner prerequisites (once)

1. **Phala access.** Run `phala login` (workspace "Tiny Cloud", profile `tinycloudxyz`), then create a Phala API key and
   store it: `gh secret set PHALA_CLOUD_API_KEY --env ptx-batch -R TinyCloudLabs/tinycloud-private-transcription`.
2. **A dedicated batch Tinfoil key** with its own quota (never ptx-dev's key). State its rate limit.
   `gh secret set BATCH_TINFOIL_API_KEY --env ptx-batch -R TinyCloudLabs/tinycloud-private-transcription`.
3. **Accept the cost.** tdx.small (1 vCPU, 2048 MB), 20 GB disk: about $0.058/h ≈ $42/month at the October 2026 rate
   (check with `phala instance-types`). Sizing below.
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
seeds admission `open`. The current API image pin contains migration 0018 but predates this PR's completion logging and
shipper configuration. After merge, publish the new image and open the required re-pin PR before deployment. The order remains:
merge → `publish-image.yml` publishes → re-pin PR merged → dispatch.

## Deploy

```bash
gh workflow run deploy-batch.yml -R $R --ref main -f confirm=ptx-batch
```


- **Tooling.** Bun is pinned, every action is SHA-pinned, and the repo's dependencies plus the Phala CLI/SDK
  ([`.github/scripts/package-lock.json`](../../.github/scripts/package-lock.json)) are installed with lifecycle scripts
  disabled before any secret is in scope. Bump the CLI by editing that `package.json` and regenerating the lockfile
  (`npm install --package-lock-only --ignore-scripts`).
- **First creation** (`PTX_BATCH_CVM_ID` unset): `phala deploy -n ptx-batch -t tdx.small --disk-size 20G
  --no-dev-os --no-public-logs --no-public-sysinfo --wait`, then a health gate, then an admission gate: a fresh install starts with
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

## Sizing (tdx.small)

The owner chose tdx.small for cost. Batch runs one job at a time and transcription is remote (Tinfoil), so the CVM
runs api + upload-worker + Postgres plus the bounded Vector log sidecar; ffmpeg/VAD handle the job in hand. The instance
type and disk apply at creation only; the update path never resizes.

**Memory.** The guest of a tdx.small reports 1,853 MiB (1,942,806,528 B). A live tdx.small (dstack 0.5.5) running two
small containers reports ~1.27 GB used, so the compose must leave at least 1,000,000,000 B to the guest OS, dstack and
dockerd. The four service caps total 896 MiB (api 320m + worker 320m + Postgres 192m + Vector 64m):

| service | `mem_limit` | `mem_reservation` | what lives there |
|---|---|---|---|
| api | 320m | 96m | Bun + Hono; PUT bodies stream to disk; ffprobe; healthcheck |
| upload-worker | 320m | 96m | Bun; ffmpeg decodes one channel at a time to PCM on disk |
| postgres | 192m | 64m | tuned Postgres; unshipped |
| log-shipper | 64m, 0.25 CPU | — | Vector allowlist and Better Stack HTTP sink; memory buffer capped at 1,000 events |

The four service caps leave 1,003,282,432 B to the guest OS, dstack and dockerd. The Docker Fluentd queue is gone. API
and upload-worker use GELF/UDP with `cache-disabled: "true"`, so Docker's dual-logging cache does not retain local app
logs while Vector is down. Postgres and Vector retain capped `json-file` logs at 10m × 3 each: at most 60 MB total on
the 20 GB disk. Vector's 1,000-event memory sink buffer remains within its 64 MiB cgroup.

Vector runs as UID/GID 65532 on its isolated `logship` bridge (`172.31.250.0/24`, fixed address `172.31.250.10`);
only `127.0.0.1:12201/udp` is published. Its root filesystem is read-only, every capability is dropped, and
`no-new-privileges:true` is enabled. `/var/lib/vector` and `/run/vector-secrets` are bounded tmpfs mounts; Vector has no
Docker-root bind, named data volume, or Docker socket.

The batch workload and sidecar limits still total 896 MiB, preserving the ≥1,000,000,000 B guest-headroom invariant.
The sink's 1,000-event memory buffer remains within Vector's 64 MiB cgroup; neither Fluentd queue nor GELF local cache exists.

`max_connections=40` covers the Bun.SQL pools (10 each: api, its boot migrator, worker) and the 3 superuser slots. A cgroup
limit also counts page cache, which the kernel reclaims first, so a container sitting near its limit while it writes
PCM is normal. An OOM kill stays inside that container.

**Private logs.** [`log-shipper/vector.yaml`](./log-shipper/vector.yaml) is canonical and embedded into
`app-compose.yaml` by `bun scripts/ptx-vector-schema.ts --write-compose`; every Compose-sensitive `$` is doubled.
CI checks the rendered bytes against `vector.yaml` and rejects repo-relative Compose files and bind sources.

Only api and upload-worker have the exact `tc.logship` service label. Docker's GELF driver exposes it as
`_tc.logship`; Postgres and Vector stay unlabelled on capped `json-file`. The socket source receives GELF/UDP on its
isolated network, with the dockerd publish bound only to host loopback. The first transform compares `_tc.logship`
exactly, then reconstructs an event from only the approved service tag and GELF `message`, removing every dockerd
underscore field and all other GELF metadata. The existing `fields.json` 25-event allowlist and 11 TC-1045 completion
fields remain unchanged. Unlabelled, unexpected-label and partial/unparseable inputs produce fixed, content-free
counters; unexpected labels emit only a throttled fixed event. The token is written from the entrypoint environment to
`/run/vector-secrets` tmpfs and resolved through Vector's `SECRET[]` local-directory provider. The entrypoint removes
the config and token variables from Vector's environment; tini (PID 1, same uid) retains the initial environment,
which is equivalent exposure to the tmpfs token file and `docker inspect`.

The API image pin contains migration 0018; it predates this PR's completion logging. After merge, publish the new image
and re-pin it before deployment.

The decode path never holds a recording in memory: ffmpeg writes 16 kHz s16le PCM to disk per channel, the VAD reads
it in 60 s slices (a 2 h channel is 72,000 frame energies, 576 KB), and each dispatch reads one region of at most
30 s (~0.96 MB WAV). [`batch-envelope.yml`](../../.github/workflows/batch-envelope.yml) proves the envelope on every
change to the batch runtime: it runs this compose (limits unchanged) on one CPU with Tinfoil mocked, uploads a
synthetic 2-hour stereo 128 kbps MP3 three times at once, and fails on any OOM kill or restart.
Run on PR #69 (GitHub runner, 1 CPU, 3 × 115 MB PUTs at localhost speed, 708 regions; 30 parallel clients polled the job
for 15 s while it decoded, 4,305 GETs, all 200):

| container | limit | pid 1 peak RSS (VmHWM) | peak anon + shmem (during the burst) | other peaks | OOM kills / restarts |
|---|---|---|---|---|---|
| api | 320 MiB | 104 MiB (bun) | 57 MiB (50 MiB) | ffprobe 25 MiB | 0 / 0 |
| upload-worker | 320 MiB | 86 MiB (bun) | 47 MiB (32 MiB) | ffmpeg 46 MiB | 0 / 0 |
| postgres | 192 MiB | 20 MiB | 71 MiB (61 MiB) | | 0 / 0 |

This phase adds the capped Vector sidecar to the runtime; rerun the two-hour `batch-envelope.yml` memory proof with the
new four-service compose before deployment. The local sidecar burst rehearsal does not replace that CVM-envelope proof.

**Disk (20 GB).** The data disk holds Docker images, Postgres and the upload volume; a live tdx.small shows an
18.87 GiB filesystem. Worst case for a 2 h recording (16 kHz s16le = 32,000 B/s per channel):

| item | bound |
|---|---|
| images (api ~0.25 GB, postgres ~0.27 GB, one update overlap; dstack prunes after `compose up`), dstack data | ≤ 2.4 GB (a live tdx.small uses 1.77 GB) |
| container logs: Postgres and Vector capped `json-file` (10m × 3 each); api/worker GELF cache disabled | ≤ 60 MB |
| Postgres data + WAL (`max_wal_size=256MB`) | ≤ 0.5 GB |
| accepted audio + in-flight `.part` files (`BATCH_MAX_RESERVED_BYTES`) | ≤ 1.21 GB |
| PCM of the one processing job: 2 ch × 7,200 s × 32,000 B/s = 0.46 GB; ×2 while a crashed claim's work dir awaits the sweeper | ≤ 0.92 GB |
| **total** | **≤ 5.1 GB ≈ 26% of 20 GB** |

Bounded use never reaches the 80% high-water (`BATCH_DISK_HIGH_WATER_PERCENT`, unchanged), which stays fail-closed for
leaks: at 80%, creates and PUTs are refused, and what can still be written after that point (3 in-flight PUTs, 0.36 GB;
one job's PCM, ≤ 0.92 GB; WAL, ~0.25 GB; ≈ 1.5 GB) fits in the remaining 4 GB with 2.6× margin.

## Browser uploads (CORS)

Exo uploads the recording straight from the browser/app to `PUT /uploads/{id}`, so the service allows those origins with
`BATCH_CORS_ORIGINS` (contract: [SPEC.md](../../SPEC.md#upload)). It is not a secret and is set on the `api` service in
[`app-compose.yaml`](./app-compose.yaml): the web app, its Pages previews, the desktop app (macOS and Windows) and the
mobile app (Android and iOS):

```
https://tinycloud.chat,https://tinychat-4jq.pages.dev,https://*.tinychat-4jq.pages.dev,tauri://localhost,http://tauri.localhost,capacitor://localhost,https://localhost
```

Check after a deploy: `curl -si -X OPTIONS $URL/uploads/trn_01M3PQ71Q9YF7GSEFP6S19ZJPW -H 'Origin: https://tinycloud.chat'
-H 'Access-Control-Request-Method: PUT'` answers `204` with `access-control-allow-origin: https://tinycloud.chat`.

## Speaker diarization

The image carries the sherpa-onnx diarization stage at `/opt/sherpa-onnx` (TitaNet-S + pyannote segmentation-3.0;
choice, numbers and sizing in [docs/diarization-benchmark.md](../../docs/diarization-benchmark.md)). It is offered only
with `BATCH_DIARIZATION_ENABLED=true` on **both** the `api` and `upload-worker` services, which
[`app-compose.yaml`](./app-compose.yaml) sets. It fits tdx.small: the worker diarizes 10-minute windows one at a time,
each in its own process inside the `upload-worker` cgroup, and links speakers across windows; the envelope CI runs a
diarized 2-hour job under the compose limits. To turn it off, set it to `"false"` on both services (a re-pin-style PR
and a deploy); capabilities then report `diarization: false` and the apps disable "Identify speakers".
Check after a deploy: `GET /v1/transcriptions/capabilities` reports `"diarization": true`, and the `batch worker
started` log line has `diarization: true`.

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

For TC-1093 quiet-mode rollback, set the optional `ptx-batch` GitHub Environment variable `BATCH_VAD_QUIET_MODE=false`
and deploy. The workflow includes it in the complete sealed deploy environment, and the worker compose passes it
through (default `true`); the existing deploy workflow syncs added env names to
the CVM allowlist. New detections use TC-1090's primary/−57 dBFS fallback regions; already committed regions and
their stats remain intact. Migration 0026 only adds nullable `transcriptions.vad_stats` JSONB, with no backfill or
default, so keep the column when rolling back an image. No data migration is needed for the flag.

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
- Go-live gate: create and verify separate Better Stack silence alerts for `svc=api` and `svc=worker`; do not open
  admission until both alerts are active.

## GELF transport and isolation

The api and upload-worker use Docker's GELF driver with `gelf-address=udp://127.0.0.1:12201`, `labels=tc.logship`, and
`cache-disabled=true`. Vector is the only service on the non-internal `logship` bridge, fixed at `172.31.250.10/24`; it
publishes UDP 12201 only on host loopback. App and Postgres containers remain on the ordinary application network and
cannot reach the Vector address or host-published listener. Postgres and Vector use capped `json-file` logs; neither has
a `tc.logship` label.

Fluentd was rejected after run 10: Vector restart yielded zero delivered events for 150 seconds, while restarting the
api restored delivery in six seconds. The file-source alternative was rejected because mounting Docker's root exposes
every container's `config.v2.json`, including environment secrets, even read-only; it also requires persisted
checkpoints.

The GELF spike shipped a genuine app line, reassembled a chunked line, received/shipped zero sibling-forged packets,
and received zero packets on external host interfaces. A 5,000-line burst sent while Vector was up lost zero; 500 lines
took 70 ms with Vector up and 89 ms with it down, with the app still running. The first dynamic-IP restart test failed.
With a fixed Vector IP, the restart diagnostic passed `docker restart`, crash plus restart policy, recreate, and a
500-line burst during downtime; each next probe arrived within one second and app restart counts stayed unchanged.
These spike results are not a substitute for the prepared five-cycle-per-path acceptance script.

Vector uses a non-root UID 65532, read-only root filesystem, `cap_drop: [ALL]`, and `no-new-privileges:true`. Only the
bounded `/var/lib/vector` data tmpfs and `/run/vector-secrets` secret tmpfs are writable. The entrypoint removes the
config and token variables from Vector's environment; tini (PID 1, same uid) retains the initial environment, which
is equivalent exposure to the tmpfs token file and `docker inspect`. API, upload-worker, and Postgres drop `NET_RAW`;
they do not need raw sockets and therefore cannot forge Ethernet frames to bypass the UDP isolation. Vector's 0.59
socket source accepts chunked GELF with a 262,144-byte source limit; the native spike reassembled 20 KiB. The shared
batch logger caps each serialized line at 15,000 UTF-8 bytes including newline, below Docker GELF's 16 KiB split point.
Oversized string fields are truncated with a marker; if a non-string payload still exceeds the cap, it emits a fixed
valid-JSON marker record. API and worker fatal handlers use the same bounded logger, so neither a giant error field nor
a runtime stack can become a valid-looking GELF tail fragment.
The local gate-counter exporter uses an 86,400-second flush period to avoid Vector's short stale-series expiry. Its
metrics endpoint is loopback-only inside Vector; the acceptance check verifies a counter increment and that the probe
content is absent from the sink.
