# TinyCloud Private Transcription API

Meeting URL in → bot joins → speaker-attributed transcript out. Public API is ours; Vexa is the
internal (replaceable) meeting-capture implementation. See [SPEC.md](./SPEC.md) for the contract.

## Layout

```
src/api/            Hono HTTP API (auth, routes, health)
src/worker/         queue loop: sends bots via Vexa, polls status, finalizes transcripts, delivers webhooks
src/db/             drizzle schema + SQL migrations
src/domain/         pure logic: IDs (mtg_+ULID), platform detection, state machine, error taxonomy, transcript normalization
src/providers/vexa/ Vexa client, types (from Vexa's frozen OpenAPI), mock server
src/providers/transcription/ TranscriptionProvider: VexaNativeProvider | TinfoilTranscriptionProvider
src/services/       meeting service (create/get/stop/delete/transition)
src/webhooks/       HMAC signature + delivery/retry
test/               unit + integration (API ↔ mock Vexa ↔ worker ↔ Postgres/Redis)
infra/dstack/       app-compose.yaml for the Phala/dstack CVM
infra/vexa/, infra/jitsi/, infra/certs/  local meeting-capture rig (pinned Vexa + docker-jitsi-meet + dev CA)
scripts/            fake-participant.ts (Playwright Alice), vexa-smoke.ts (rig gate), make-fixture.sh
docs/               vexa-findings.md (observed Vexa behaviour) + vexa-samples/*.json (real payloads)
test/e2e/           real end-to-end test against the capture rig (E2E=1)
```

## Meeting-capture rig (real Vexa + Jitsi, no GPU)

Local pinned Vexa (v012 images, CPU faster-whisper) on gateway **:18066**, docker-jitsi-meet at
`https://jitsi.local:8443` (anonymous rooms, our dev CA baked into a derived bot image) and a Playwright
fake participant ("Alice", plays `fixtures/alice.wav`). Exact bring-up commands: [infra/README.md](./infra/README.md).
Gate: `bun run vexa:smoke` (green 3/3). Observed API shapes: [docs/vexa-findings.md](./docs/vexa-findings.md).


## Run locally

Requires Bun ≥ 1.3 and Docker (`sudo docker` on the dev host).

```bash
bun install
sudo docker compose -f docker-compose.dev.yml up -d      # Postgres :55432, Redis :56379
cp .env.example .env                                     # defaults match the compose above

# 1) a Vexa: the real stack (VEXA_BASE_URL/VEXA_API_KEY) or the built-in mock
VEXA_API_KEY=vxa_mock bun run mock-vexa                  # http://localhost:18056

# 2) API + worker (in two shells; both read .env / process env)
VEXA_API_KEY=vxa_mock bun run api                        # migrates, listens on :8080
VEXA_API_KEY=vxa_mock bun run worker

# 3) mint an API key (printed once; only the sha256 hash is stored)
bun run cli create-key --project demo
```

`bun test` runs unit + integration (needs the dev Postgres/Redis; the mock Vexa is started in-process).
`bun run test:e2e` runs the REAL happy path (`test/e2e/happy-path.test.ts`, skipped unless `E2E=1`) against
the capture rig — it brings up nothing itself: follow [infra/README.md](./infra/README.md) first, then
run it; it mints a Vexa key via admin-api, starts api+worker in-process, creates a meeting in a random
`https://jitsi.local:8443/<room>`, sends Alice, waits for `completed`, checks transcript + signed webhook,
then deletes. Green 2/2 on 2026-08-17 (~2 min each; evidence in `tmp/e2e-<room>.json`).

### Env vars

| var | default | notes |
|---|---|---|
| `PORT` | `8080` | API port |
| `DATABASE_URL` | `postgres://ptx:ptx@localhost:55432/ptx` | |
| `REDIS_URL` | `redis://localhost:56379` | queue |
| `VEXA_BASE_URL` | `http://localhost:18066` | Vexa API gateway (capture rig). Mock: `http://localhost:18056` |
| `VEXA_API_KEY` | – | sent as `X-API-Key` |
| `VEXA_POLL_INTERVAL_MS` | `5000` | worker status/transcript poll |
| `TRANSCRIPTION_PROVIDER` | `vexa` | `vexa` (WhisperLive passthrough) or `tinfoil` |
| `TINFOIL_BASE_URL` | `https://inference.tinfoil.sh` | OpenAI-compatible `/v1/audio/transcriptions` |
| `TINFOIL_API_KEY` | – | no live calls are made in tests |
| `TINFOIL_MODEL` | `voxtral-small-24b` | |
| `AUTO_MIGRATE` | `true` | API runs migrations at boot |
| `LOG_LEVEL` | `info` | JSON logs |

## Curl walkthrough (Definition of Done)

```bash
export KEY=tc_live_...            # from `bun run cli create-key`
export API=http://localhost:8080

# create → {"id":"mtg_…","status":"queued",...}
# (against the local rig use a https://jitsi.local:8443/<room> URL and put someone in the room:
#  `bun run fake-participant -- --url https://jitsi.local:8443/<room> --seconds 80`)
curl -s -X POST $API/v1/meetings -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-1' \
  -d '{"meeting_url":"https://meet.jit.si/TinyCloudDemo","bot_name":"TinyCloud Notetaker","language":"en",
       "webhook_url":"https://example.com/hooks/tc","metadata":{"customer":"acme"}}'

# status: queued → joining → waiting_for_admission → in_progress → processing → completed
curl -s $API/v1/meetings/$ID -H "Authorization: Bearer $KEY"

# transcript: 202 {"meeting_id","status"} until completed, then speakers/segments/text
curl -s -i $API/v1/meetings/$ID/transcript -H "Authorization: Bearer $KEY"

# stop (idempotent) → {"id","status"}
curl -s -X POST $API/v1/meetings/$ID/stop -H "Authorization: Bearer $KEY"

# delete → 204 (asks Vexa to delete too; Vexa v0.12 keeps bot-owned rows and answers 409 — logged, see "Known gaps")
curl -s -X DELETE $API/v1/meetings/$ID -H "Authorization: Bearer $KEY"

curl -s $API/health   # {"status":"ok","checks":{postgres,redis,vexa,bot_capacity,transcription_provider}}
```

With the mock Vexa you drive the lifecycle yourself:

```bash
curl -s -X POST localhost:18056/_mock/meetings/jitsi/TinyCloudDemo -H 'Content-Type: application/json' \
  -d '{"status":"active"}'
curl -s -X POST localhost:18056/_mock/meetings/jitsi/TinyCloudDemo -H 'Content-Type: application/json' \
  -d '{"status":"completed","completion_reason":"stopped","segments":[
        {"start":0,"end":2.5,"text":"Hello from the demo.","speaker":"Sam","language":"en","completed":true}]}'
```

### Webhooks

`meeting.completed` / `meeting.failed` are POSTed to `webhook_url` as
`{"id":"evt_…","type":"meeting.completed","created_at":"…","data":{"meeting_id":"…","metadata":{}}}`
(`data.error` is added on failure). Header `X-Webhook-Signature: sha256=<hex>` is HMAC-SHA256 over the
raw body with the project's webhook secret (printed by `create-key`). Retries: immediate, 1m, 5m, 30m, 2h,
persisted in `webhook_deliveries`. Webhook failure never changes meeting status.

### Errors

`{"error":{"type":"meeting_join_failed","code":"waiting_room_timeout","message":"…"}}`. Codes:
`invalid_meeting_url, unsupported_platform, meeting_not_found, meeting_join_failed, waiting_room_timeout,
bot_removed, meeting_ended, capture_failed, transcription_failed, provider_timeout, provider_unavailable,
internal_error` (+ `unauthorized`, `invalid_request`, `idempotency_conflict`). Vexa errors are never forwarded raw.

## Vexa mapping (typed against the real v0.12 payloads in `docs/vexa-samples/`)

Types in `src/providers/vexa/types.ts`; pure mapping in `src/providers/vexa/adapter.ts` (unit-tested against
`docs/vexa-samples/vexa-transcript.json`). Behaviour observed on the pinned rig (`docs/vexa-findings.md`):

- `POST /bots` `{platform:"jitsi", meeting_url, bot_name, language}` → 201 `MeetingResponse` (`status:"requested"`,
  integer `id`, `native_meeting_id` = `<room>@<host>` for self-hosted Jitsi). Everything else is addressed by
  `(platform, native_meeting_id)`; we store the native id as an opaque string.
- `GET /transcripts/{platform}/{native_meeting_id}` is the worker's single poll: `status`
  (`requested → joining → active → stopping → completed`, or `failed`), `start_time` (bot active), `segments[]`,
  `recordings[]`, and **`data.completion_reason`** (that is where it lives on transcript rows; the top-level
  field exists only on MeetingResponse rows). `data.failure_stage`, `data.last_error`, `data.status_transition[]` also exist.
- Segments: `{start,end,text,language,speaker,completed,segment_id,absolute_start_time,absolute_end_time}`.
  `start`/`end` are **epoch seconds** → we rebase to meeting-relative seconds (origin = `start_time` when it
  precedes the first segment, else the first segment). `segment_id` is `turn:N:<seq>` (confirmed; a turn can
  have several) or `turn:N:p<seq>` (draft) → drafts of a turn that has confirmed rows are dropped, ids are
  upserted (last wins), `completed:false` rows are dropped. `speaker` is the Jitsi display name.
- Status map: `requested|joining→joining`, `awaiting_admission|needs_help→waiting_for_admission`,
  `active→in_progress`, `stopping|completed→processing` (then `completed` once our transcript is stored),
  `failed→failed`; `completion_reason` → our error codes (`src/domain/state.ts`).
- `DELETE /bots/{p}/{id}` → 200 `{status:"stopping",meeting_id,native_meeting_id}`; 404 once no bot is active.
- `GET /bots/status` → `{running:[MeetingResponse…], running_bots:[…same], count}` (non-terminal rows only).
- Recordings (Tinfoil batch input): `recordings[]` on the transcript row (or `GET /recordings`, filtered by
  `meeting_id`) → `GET /recordings/{id}/master?type=audio` assembles `master.webm` → `raw_url` streams the bytes
  (`X-API-Key` required). `src/worker/meeting-job.ts#fetchVexaAudio` applies a content sanity check
  (bytes/second below ~1 kB/s ⇒ treated as the known silent-tap failure and skipped).

### Known gaps / risks

- **Vexa data retention on DELETE**: Vexa v0.12 only deletes *planned* rows; `DELETE /meetings/{p}/{id}` on a
  meeting the bot lifecycle touched answers `409 "Meeting is no longer planned (bot lifecycle owns it)"`.
  Our DELETE removes our data and logs the 409; purging Vexa's copy needs an upstream route or a direct
  DB/MinIO purge inside the CVM (follow-up).
- **Silent recording** (1 of 3 rig runs): the bot's recording tap can latch onto a stale element on the very
  first meeting after a cold stack. Batch Tinfoil is "viable with content sanity check"; the fallback is
  the WhisperLive shim (not built).
- **Jitsi live validation** is marked pending upstream; it works against docker-jitsi-meet stable-11146-2
  (bot needs `https://` + hostname + a trusted cert).
- The capture rig needed a host iptables fix (Docker's FORWARD/NAT chains had been flushed) — see infra/README.md.

## Deploy (Phala/dstack)

`infra/dstack/app-compose.yaml` runs api + worker + postgres + redis and the pinned Vexa v0.12 stack
(admin-api, runtime, meeting-api, gateway, valkey, postgres, MinIO, CPU whisper) in ONE CVM; only `:8080`
is published. Bot spawning needs `/var/run/docker.sock` mounted into Vexa's `runtime` (one container per
bot on the fixed `ptx-vexa` network). A one-shot `vexa-provision` job mints the Vexa API key at first boot.
`bot-image-keeper` (a no-op container on `vexaai/vexa-bot`) makes compose pull the bot image and pins it:
Vexa's runtime does `docker create` without pulling, and dstack runs `docker image prune -af` after every
`compose up`, so without a referencing container the bot image is pruned and every meeting fails with
`provider_unavailable` ("No such image: vexaai/vexa-bot:v012").
If the docker.sock bind is ever refused by the platform, the alternative is Vexa's process backend
("Vexa Lite": bot as a sibling service / in-process instead of docker-spawned containers).

**Workspace.** The dev CVM `ptx-dev` lives in the **TinyCloud** Phala workspace (slug `tinycloudxyz`,
CLI profile `openkey-prod`), not in the personal "skgbafa's projects" workspace. Always
`phala switch openkey-prod` (and check `phala status` says `Current Workspace: TinyCloud`) before touching it,
and never modify the `openkey-api` CVM.

**Image.** The api/worker image is `ghcr.io/tinycloudlabs/tinycloud-private-transcription` (`:<git sha>`
immutable, `:v1` moving on feat/v1 + main, `:latest` on main), built for linux/amd64 and pushed by the
GitHub Actions workflow `.github/workflows/publish-image.yml` on every push to `feat/v1` / `main` that touches
the Dockerfile, `src/`, or the lockfile (or `gh workflow run publish-image.yml`). It authenticates with the
workflow's `GITHUB_TOKEN` (`packages: write`); watch it with `gh run watch` and take the digest from the run
summary. Pin `PTX_IMAGE=ghcr.io/tinycloudlabs/tinycloud-private-transcription:<sha>` (or `:v1`) in
`infra/dstack/.env`.

The CVM must be able to pull that image. dstack's pre-launch script runs `docker image prune -af` on every
boot and `docker compose pull` before `up`, so a pre-pulled image does not survive an update — the registry
itself has to be reachable. Two options:

1. **Public package (preferred).** The repo is private, so the package is created private and there is no
   REST endpoint to change container-package visibility; a human flips it once in the UI: GitHub → org
   TinyCloudLabs → Packages → `tinycloud-private-transcription` → Package settings → Danger Zone → Change
   visibility → Public. Verify with `sudo docker logout ghcr.io && sudo docker pull ghcr.io/tinycloudlabs/tinycloud-private-transcription:v1`.
2. **Sealed pull credentials.** Add `DSTACK_DOCKER_REGISTRY=ghcr.io`, `DSTACK_DOCKER_USERNAME=<github user>`,
   `DSTACK_DOCKER_PASSWORD=<PAT with read:packages only>` to `infra/dstack/.env`; the pre-launch script does
   `docker login ghcr.io` with them before pulling. Do not use a broad-scope OAuth/PAT here.

**Fallback (no registry access, expires in 24 h)** — anonymous ttl.sh push from the dev host:

```bash
git archive HEAD Dockerfile package.json bun.lock src drizzle.config.ts tsconfig.json | tar -x -C /tmp/ptx-build
sudo docker build --platform linux/amd64 -t ttl.sh/ptx-api-$(git rev-parse --short HEAD):24h /tmp/ptx-build
sudo docker push ttl.sh/ptx-api-$(git rev-parse --short HEAD):24h      # then set PTX_IMAGE to that tag
```
Containers already running keep their image across restarts (compose pull is fail-soft, and referenced images
are not pruned), but a redeploy after expiry cannot re-pull it.

**Env.** `cp infra/dstack/.env.example infra/dstack/.env` (gitignored) and fill it: random 32-char values for
`POSTGRES_PASSWORD`, `VEXA_DB_PASSWORD`, `VEXA_ADMIN_TOKEN`, `VEXA_INTERNAL_API_SECRET`, `MINIO_ROOT_PASSWORD`;
`PTX_IMAGE`; and for private transcription `TRANSCRIPTION_PROVIDER=tinfoil`, `TINFOIL_API_KEY`,
`TINFOIL_MODEL` (from the project `.env`). Everything in that file is encrypted client-side and sealed into
the CVM (`phala deploy -e`); nothing secret lives in `app-compose.yaml`.

**Deploy / update.**

```bash
phala switch openkey-prod && phala status                       # Current Workspace: TinyCloud
sudo docker compose -f infra/dstack/app-compose.yaml --env-file infra/dstack/.env config -q   # compose sanity
phala deploy -n ptx-dev -c infra/dstack/app-compose.yaml -e infra/dstack/.env -t tdx.large --disk-size 40G --wait
phala cvms get ptx-dev --json | jq '{status, app_id, gateway}'
# update in place (new image tag / env / compose):
phala deploy --cvm-id ptx-dev -c infra/dstack/app-compose.yaml -e infra/dstack/.env --wait
phala switch openkey-secondary                                  # restore the default profile when done
```

`tdx.large` (4 vCPU / 8 GB, ~$0.24/h incl. 40 GB disk) is the smallest size that fits whisper small.en +
one bot + the control plane; smaller types OOM. First boot takes ~5–10 min (Vexa images ≈ 3.6 GB bot image
+ whisper model download).

**Current dev CVM** (2026-08-18): `ptx-dev`, app id `7fd569fb6ac2cae943cea1d1aff247cd8ea61fdc`, uuid
`9a79a27e-8243-4fd7-b17d-fc9300333784`, node prod5 (US-WEST-1), `tdx.large`, dev OS (SSH enabled via
`phala ssh-keys add` + restart), API at
`https://7fd569fb6ac2cae943cea1d1aff247cd8ea61fdc-8080.dstack-pha-prod5.phala.network`.

**Verify.** `https://<app_id>-8080.<gateway base_domain>/health` →
`{"status":"ok","checks":{"postgres":true,"redis":true,"vexa":true,...}}`. Then mint a key inside the CVM
and run the [curl walkthrough](#curl-walkthrough-definition-of-done):

```bash
phala ssh-keys add --name <host> --key-file ~/.ssh/id_ed25519.pub && phala cvms restart ptx-dev   # once (dev OS only)
phala ssh ptx-dev -- -i ~/.ssh/id_ed25519 "docker exec dstack-api-1 bun run src/cli.ts create-key --project demo"
export API=https://<app_id>-8080.<base_domain> KEY=tc_live_...
curl -s -X POST $API/v1/meetings -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"meeting_url":"https://meet.jit.si/<room>","bot_name":"TinyCloud Notetaker","language":"en"}'
```

Debug: `phala logs ptx-dev -f`, `phala logs ptx-dev --serial --tail 200` (image pull / compose errors), `phala ps ptx-dev`.

