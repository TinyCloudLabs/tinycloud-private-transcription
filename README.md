# TinyCloud Private Transcription API

**Status: pre-release / V1.**

A meeting primitive: send a meeting URL in, a bot joins the call, and you get a speaker-attributed,
structured transcript out — with state you can track (`queued → joining → waiting_for_admission →
in_progress → processing → completed`) and signed webhooks on completion. The public API (meetings,
transcripts, webhooks, error taxonomy) is ours and is the contract clients build against;
[Vexa](https://github.com/Vexa-ai/vexa) is the internal, replaceable meeting-capture implementation, and
transcription can run either on Vexa's own WhisperLive or on a confidential-inference provider (Tinfoil)
inside a Phala/dstack CVM, so meeting audio never leaves attested hardware. The full contract is in
[SPEC.md](./SPEC.md).

## Quickstart

```bash
bun install
sudo docker compose -f docker-compose.dev.yml up -d      # Postgres :55432, Redis :56379
cp .env.example .env
VEXA_API_KEY=vxa_mock bun run mock-vexa                  # built-in Vexa mock on :18056
VEXA_API_KEY=vxa_mock bun run api                        # API on :8080 (runs migrations)
VEXA_API_KEY=vxa_mock bun run worker                     # queue worker
bun run cli create-key --project demo                    # prints a tc_live_… key once
```

Then follow the [curl walkthrough](#curl-walkthrough-definition-of-done). For a real bot in a real
(local) meeting see [Meeting-capture rig](#meeting-capture-rig-real-vexa--jitsi-no-gpu); for a CVM see
[Deploy](#deploy-phaladstack).

Security issues: see [SECURITY.md](./SECURITY.md) (security@tinycloud.xyz or GitHub private vulnerability
reporting). Contributions: [CONTRIBUTING.md](./CONTRIBUTING.md). License: [TOSL v1.5](./LICENSE.md);
third-party components: [THIRD_PARTY.md](./THIRD_PARTY.md).

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
| `VEXA_MAX_CONCURRENT_BOTS` | `5` | provisioned bot ceiling (matches `max_concurrent_bots` in infra/dstack/app-compose.yaml); reported as `bot_capacity.max` in `/health` |
| `ENABLED_PLATFORMS` | `jitsi` | comma-separated platforms accepted by `POST /v1/meetings`. Others (zoom, google_meet, microsoft_teams) are still detected but answer 400 `unsupported_platform` |
| `JOIN_TIMEOUT_SECONDS` | `600` | worker-side join deadline: a meeting still `joining`/`waiting_for_admission` this long after bot dispatch is failed (`meeting_join_failed`/`waiting_room_timeout`), its bot stopped, and `meeting.failed` emitted |
| `TRANSCRIPTION_PROVIDER` | `vexa` | `vexa` (WhisperLive passthrough) or `tinfoil` |
| `TINFOIL_BASE_URL` | `https://inference.tinfoil.sh` | OpenAI-compatible `/v1/audio/transcriptions` |
| `TINFOIL_API_KEY` | – | no live calls are made in tests |
| `TINFOIL_MODEL` | `voxtral-small-24b` | |
| `TINFOIL_SEGMENTATION` | `turns` | `turns` (one Tinfoil call per Vexa speaker turn, keeps segmentation) or `whole` (one call, one segment) — see below |
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

curl -s $API/health   # {"status":"ok","checks":{postgres,redis,vexa,bot_capacity:{running,max},transcription_provider}}
```

With the mock Vexa you drive the lifecycle yourself:

```bash
curl -s -X POST localhost:18056/_mock/meetings/jitsi/TinyCloudDemo -H 'Content-Type: application/json' \
  -d '{"status":"active"}'
curl -s -X POST localhost:18056/_mock/meetings/jitsi/TinyCloudDemo -H 'Content-Type: application/json' \
  -d '{"status":"completed","completion_reason":"stopped","segments":[
        {"start":0,"end":2.5,"text":"Hello from the demo.","speaker":"Alice","language":"en","completed":true}]}'
```

### Webhooks

`meeting.completed` / `meeting.failed` are POSTed to `webhook_url` as
`{"id":"evt_…","type":"meeting.completed","created_at":"…","data":{"meeting_id":"…","metadata":{},"transcript_provider":"tinfoil"}}`
(`data.error` is added on failure; `data.fallback_from`/`data.fallback_reason` are added when the
configured provider fell back to the Vexa-native transcript). Header `X-Webhook-Signature: sha256=<hex>` is HMAC-SHA256 over the
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

## Confidential transcription (Tinfoil)

`TRANSCRIPTION_PROVIDER=tinfoil` transcribes the **persisted meeting recording** on Tinfoil's confidential
inference (`POST /v1/audio/transcriptions`, OpenAI-compatible, `voxtral-small-24b`) instead of using
Vexa's WhisperLive words. Verified live: Voxtral on Tinfoil rejects `response_format=verbose_json` (400) and
`json` returns `{text, usage:{seconds}}` only — **no timestamps, no diarization** — so speaker segmentation
has to come from Vexa's speaker timeline. `src/providers/transcription/tinfoil.ts`:

1. The worker asks Vexa for `recording_enabled`, and at completion downloads the audio master
   (`fetchVexaAudio`, with the bitrate sanity check for the known silent-tap capture).
2. `TINFOIL_SEGMENTATION=turns` (default): the recording is decoded **once** with `ffmpeg` (16 kHz mono PCM,
   temp files; `apk add ffmpeg` in the Dockerfile), Vexa's speaker-labelled segments (already
   meeting-relative, same origin as the recording = the bot's `start_time`) are merged into **turns**
   (adjacent same-speaker segments with a gap ≤ 0.75 s), each turn is cut from the PCM (±0.25 s pad; turns
   < 0.4 s skipped) into a WAV clip and sent to Tinfoil — ≤ 3 concurrent calls, ≤ 2 retries with backoff on
   5xx/429/timeouts. Result: one segment per turn with `speaker_id/speaker_name` and `start/end` from Vexa,
   `text` from Tinfoil; `text` = `Speaker: …` lines; `duration_seconds` = the recording's length. A failed
   minority of turns keeps Vexa's own words for those turns (logged). Cost: one call of a few seconds per
   turn (a 30 s two-person exchange ≈ 5–10 calls, ~2–3 s wall time total).
   `TINFOIL_SEGMENTATION=whole`: one call with the whole recording; one segment attributed to the dominant
   Vexa speaker (no segmentation) — also what `turns` does when Vexa heard no segments at all.
3. **Fallback to the Vexa-native transcript** (never a failed meeting when Vexa has words): no usable
   recording (none persisted / silent tap), recording silent (< −60 dBFS RMS) or undecodable, more than
   half of the turns failing (4xx), or Tinfoil unavailable after the worker's 3 retries in `processing`.
   The worker logs `falling back to vexa-native transcript {reason}` + `transcript finalized
   {provider, fallback_from, fallback_reason, stats}`; the stored transcript and `GET /transcript` carry
   **`provider: "tinfoil" | "vexa"`** (`transcripts.provider`), so callers can tell which path produced it.
   The fallback is also persisted (`transcripts.fallback_from`/`fallback_reason`) and surfaced to clients:
   `GET /v1/meetings/{id}` (once completed) and the `meeting.completed` webhook `data` carry
   `transcript_provider` plus `fallback_from`/`fallback_reason` when a fallback fired.

Limits: turn mode only covers speech Vexa segmented (whole-file mode covers everything but loses speakers);
Vexa's speaker labels come from Jitsi dominant-speaker events (`"Speaker"` = unknown). ~~Vexa v0.12's
recording tap only mixes the media elements present when it starts~~ — **fixed in our Vexa fork**
([TinyCloudLabs/vexa](https://github.com/TinyCloudLabs/vexa) branch `tinycloud`, see "Vexa fork" below): the
record-chunker's tap is now dynamic (rescans like the live mixer), so a participant who joins after the bot
IS in the recording; verified live with Bob joining after the bot (`scripts/two-speaker-live.ts`, per-turn
Tinfoil transcript carries Bob's words, 2/2 runs 2026-08-19). Probes: `bun run scripts/tinfoil-check.ts [--two-speakers]` (1–2 live calls),
`bun run scripts/two-speaker-live.ts` (Alice + Bob on the rig, per-turn path), `TRANSCRIPTION_PROVIDER=tinfoil
bun run test:e2e` (asserts `transcript.provider === "tinfoil"`; green 2/2 on 2026-08-19, 2 + 3 calls).

### Known gaps / risks

- **Vexa data retention on DELETE**: Vexa v0.12 only deletes *planned* rows; `DELETE /meetings/{p}/{id}` on a
  meeting the bot lifecycle touched answers `409 "Meeting is no longer planned (bot lifecycle owns it)"`.
  Our DELETE removes our data and logs the 409; purging Vexa's copy needs an upstream route or a direct
  DB/MinIO purge inside the CVM (follow-up).
- **Silent recording**: fixed in our Vexa fork for the known causes (static tap latching a stale element /
  nobody with audio present at bot join — the tap now starts over an empty mix and attaches audio as it
  appears). The worker's bitrate/RMS sanity check + Vexa-native fallback stay as defence in depth.
- **Recording misses late audio tracks**: **fixed in our Vexa fork** (dynamic record-chunker, see "Vexa
  fork" below); verified live 2/2 with Bob joining after the bot.
- **Jitsi live validation** is marked pending upstream; it works against docker-jitsi-meet stable-11146-2
  (bot needs `https://` + hostname + a trusted cert).
- The capture rig needed a host iptables fix (Docker's FORWARD/NAT chains had been flushed) — see infra/README.md.

## Vexa fork ([TinyCloudLabs/vexa](https://github.com/TinyCloudLabs/vexa))

Our per-turn confidential path transcribes the **persisted recording**, so the recording must hear
everyone. Upstream Vexa v0.12's record-chunker attached only the media tracks present when the tap
started: a participant joining after the bot was missing from `master.webm` (the live transcript still
heard them), and an empty-at-join room produced a silent/absent master. Upstream's live mixer already
rescans for late tracks; the recording tap did not — so we maintain a fork rather than wait upstream.

- **Branches**: `tinycloud` = upstream base (`e0b356d6`, v0.12.22) + our patches — this is what the rig
  pins (`infra/vexa/upstream` submodule, `infra/vexa/UPSTREAM_PIN`). `main` tracks upstream untouched.
- **The patch**: `core/meetings/modules/record-chunker` — `createRecordingTap` now builds a dynamic mix
  (`DynamicElementMixer`): recorder starts immediately (even with zero audio elements) and a 2 s rescan
  (live-mixer parity) attaches new elements / detaches ended ones. Pinned by the module's
  `dynamic-tap.smoke.test.ts`.
- **Bot image**: `ghcr.io/tinycloudlabs/vexa-bot:tc-<shortsha>` (fork workflow `tinycloud-bot-image`);
  the rig layers the dev CA on top (`infra/vexa/bot/Dockerfile` → `ptx/vexa-bot:tc-devca`). Control-plane
  images stay upstream `vexaai/v012-*:v012`.
- **Syncing upstream** (in the fork repo): `git fetch upstream --tags && git checkout main && git merge
  --ff-only upstream/main && git push origin main --tags`, then rebase/merge `tinycloud` onto `main`,
  re-run the record-chunker tests, push, and bump this repo's submodule pin + bot image tag.
- License unchanged: Apache-2.0, upstream `LICENSE` intact; changes marked per Apache-2.0 §4(b).

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

**Workspace.** Deploy from a Phala Cloud workspace you control (`phala switch <profile>` and confirm with
`phala status` before touching anything); the examples below use a CVM named `ptx-dev`.

**Image.** The api/worker image is `ghcr.io/tinycloudlabs/tinycloud-private-transcription/api` (`:<git sha>`
immutable, `:v1` moving on feat/v1 + main, `:latest` on main), built for linux/amd64 and pushed by the
GitHub Actions workflow `.github/workflows/publish-image.yml` on every push to `feat/v1` / `main` that touches
the Dockerfile, `src/`, or the lockfile (or `gh workflow run publish-image.yml`). It authenticates with the
workflow's `GITHUB_TOKEN` (`packages: write`); watch it with `gh run watch` and take the digest from the run
summary. Pin `PTX_IMAGE=ghcr.io/tinycloudlabs/tinycloud-private-transcription/api:<sha>` (or `:v1`) in
`infra/dstack/.env`. (The older package `ghcr.io/tinycloudlabs/tinycloud-private-transcription` — no `/api`
suffix — was created while the repo was private, is stuck private, and is deprecated; nothing pushes to it.)

The CVM must be able to pull that image. dstack's pre-launch script runs `docker image prune -af` on every
boot and `docker compose pull` before `up`, so a pre-pulled image does not survive an update — the registry
itself has to be reachable. Two options:

1. **Public package (preferred, current setup).** A GHCR package created by a workflow inherits the repository's
   visibility at creation time (the `org.opencontainers.image.source` label links it to the repo). The `/api`
   package was created after the repo went public and is public; if it ever ends up private there is no REST
   endpoint to change it — flip it once in the UI: GitHub → org TinyCloudLabs → Packages →
   `tinycloud-private-transcription/api` → Package settings → Danger Zone → Change visibility → Public. Verify
   with `sudo docker logout ghcr.io && sudo docker manifest inspect ghcr.io/tinycloudlabs/tinycloud-private-transcription/api:v1`.
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
phala status                                                    # confirm the intended workspace
sudo docker compose -f infra/dstack/app-compose.yaml --env-file infra/dstack/.env config -q   # compose sanity
phala deploy -n ptx-dev -c infra/dstack/app-compose.yaml -e infra/dstack/.env -t tdx.large --disk-size 40G --wait
phala cvms get ptx-dev --json | jq '{status, app_id, gateway}'
# update in place (new image tag / env / compose):
phala deploy --cvm-id ptx-dev -c infra/dstack/app-compose.yaml -e infra/dstack/.env --wait
```

`tdx.large` (4 vCPU / 8 GB, ~$0.24/h incl. 40 GB disk) is the smallest size that fits whisper small.en +
one bot + the control plane; smaller types OOM. First boot takes ~5–10 min (Vexa images ≈ 3.6 GB bot image
+ whisper model download).

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

