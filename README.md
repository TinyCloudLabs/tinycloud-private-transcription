# TinyCloud Private Transcription API

**Status: pre-release / V1.**

A meeting primitive: send a meeting URL in, a bot joins the call, and you get a speaker-attributed,
structured transcript out — with state you can track (`queued → joining → waiting_for_admission →
in_progress → processing → completed`) and signed webhooks on completion. The public API (meetings,
transcripts, webhooks, error taxonomy) is ours and is the contract clients build against;
[Vexa](https://github.com/Vexa-ai/vexa) is the internal, replaceable meeting-capture implementation.
TinyCloud stores Vexa's completed, speaker-attributed segments and never downloads recordings or runs a
second transcription pass. The full contract is in [SPEC.md](./SPEC.md).

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
src/providers/transcription/ Vexa segment normalization provider
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
then deletes. The test uses `E2E_AUTO_LEAVE_MS` (default `60000`) so it does not wait for the five-minute
production window. Green 2/2 on 2026-08-17 (~2 min each; evidence in `tmp/e2e-<room>.json`).

### Env vars

| var | default | notes |
|---|---|---|
| `PORT` | `8080` | API port |
| `DATABASE_URL` | `postgres://ptx:ptx@localhost:55432/ptx` | |
| `REDIS_URL` | `redis://localhost:56379` | queue |
| `VEXA_BASE_URL` | `http://localhost:18066` | Vexa API gateway (capture rig). Mock: `http://localhost:18056` |
| `VEXA_API_KEY` | – | sent as `X-API-Key` |
| `VEXA_POLL_INTERVAL_MS` | `5000` | worker status/transcript poll |
| `VEXA_MAX_TIME_LEFT_ALONE_MS` | `300000` | per-meeting window without remote participant audio (milliseconds). After five minutes without hearing anyone else, Vexa completes the bot as `left_alone`; applies to Jitsi and Google Meet. |
| `VEXA_MAX_CONCURRENT_BOTS` | `5` | provisioned bot ceiling (matches `max_concurrent_bots` in infra/dstack/app-compose.yaml); reported as `bot_capacity.max` in `/health` |
| `ENABLED_PLATFORMS` | `jitsi` | comma-separated platforms accepted by `POST /v1/meetings`. Others (zoom, google_meet, microsoft_teams) are still detected but answer 400 `unsupported_platform` |
| `SIGNAL_CAPTURE_URLS` | `http://127.0.0.1:18076` | ordered capture-worker endpoints, one per persistent Signal Desktop seat |
| `SIGNAL_CAPTURE_TOKEN_PATHS` | none | ordered private control-token files; required for non-loopback capture endpoints |
| `SIGNAL_CAPABILITY_KEY` | none | required only outside dstack; dstack self-provisions a durable private-volume key used to encrypt Signal call URL fragments at rest |
| `SIGNAL_MAX_CONCURRENT_CALLS` | `1` | provisioned Signal Desktop seat count; production compose pins `3` |
| `SIGNAL_PULSE_SOURCE` | `ptx_sink.monitor` in dstack | PulseAudio monitor captured by the isolated Signal seat |
| `SIGNAL_TRANSCRIBER` | bundled dstack adapter | local WAV-to-JSON adapter using the in-CVM Whisper service |
| `JOIN_TIMEOUT_SECONDS` | `600` | worker-side join deadline: a meeting still `joining`/`waiting_for_admission` this long after bot dispatch is failed (`meeting_join_failed`/`waiting_room_timeout`), its bot stopped, and `meeting.failed` emitted |
| `TRANSCRIPTION_PROVIDER` | `vexa` | Compatibility label; Vexa remains the primary provider and is reported by health. |
| `TINFOIL_BASE_URL` | `https://inference.tinfoil.sh` | OpenAI-compatible confidential transcription endpoint used only for recovery. |
| `TINFOIL_API_KEY` | – | bearer token; when set, enables recording retention and recovery transcription. |
| `TINFOIL_MODEL` | `voxtral-small-24b` | recovery transcription model. |
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

# recover a failed meeting from its retained capture-provider row (idempotent)
curl -s -X POST $API/v1/meetings/$ID/recover -H "Authorization: Bearer $KEY"

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
`{"id":"evt_…","type":"meeting.completed","created_at":"…","data":{"meeting_id":"…","metadata":{},"transcript_provider":"vexa"}}`
(`data.error` is added on failure.) Header `X-Webhook-Signature: sha256=<hex>` is HMAC-SHA256 over the
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
  and **`data.completion_reason`** (that is where it lives on transcript rows; the top-level
  field exists only on MeetingResponse rows). `data.failure_stage`, `data.last_error`, `data.status_transition[]` also exist.
- Segments: `{start,end,text,language,speaker,completed,segment_id,absolute_start_time,absolute_end_time}`.
  `start`/`end` may be epoch seconds or meeting-relative seconds. Epoch values are rebased (origin =
  `start_time` when it precedes the first segment, else the first segment); relative values pass through.
  `segment_id` is `turn:N:<seq>` (confirmed; a turn can
  have several) or `turn:N:p<seq>` (draft) → drafts of a turn that has confirmed rows are dropped, ids are
  upserted (last wins), `completed:false` rows are dropped. `speaker` is the Jitsi display name.
- Status map: `requested|joining→joining`, `awaiting_admission|needs_help→waiting_for_admission`,
  `active→in_progress`, `stopping|completed→processing` (then `completed` once our transcript is stored),
  `failed→failed`; `completion_reason` → our error codes (`src/domain/state.ts`).
- `DELETE /bots/{p}/{id}` → 200 `{status:"stopping",meeting_id,native_meeting_id}`; 404 once no bot is active.
- `GET /bots/status` → `{running:[MeetingResponse…], running_bots:[…same], count}` (non-terminal rows only).
## Vexa-native transcript ingestion

Every meeting requests live Vexa transcription. When Tinfoil recovery is configured, it also requests a
retained mixed recording. On completion, TinyCloud validates, de-duplicates, rebases, normalizes, and stores
a complete Vexa speaker-attributed timeline unchanged. If terminal timestamps show that Vexa lost a material
tail, TinyCloud transcribes the retained recording through Tinfoil's text-STT endpoint. Tinfoil does no
diarization: recovered segments use `Unknown` speakers. `POST /v1/meetings/{id}/recover` remains tenant-scoped;
transcript storage is an upsert and only the winning terminal transition emits a webhook.

### Known gaps / risks

- **Quiet meetings can auto-end**: Vexa currently infers an empty room from the absence of remote
  participant audio, not participant count. Five continuous silent minutes (for example, a break or
  quiet screen-share) can therefore finalize a meeting even if people remain connected. Use
  `POST /v1/meetings/{id}/stop` to end immediately; tune `VEXA_MAX_TIME_LEFT_ALONE_MS` for longer silence.
- **Vexa data retention on DELETE**: Vexa v0.12 only deletes *planned* rows; `DELETE /meetings/{p}/{id}` on a
  meeting the bot lifecycle touched answers `409 "Meeting is no longer planned (bot lifecycle owns it)"`.
  Our DELETE removes our data and logs the 409; purging Vexa's copy needs an upstream route or a direct
  DB/MinIO purge inside the CVM (follow-up).
- **Jitsi live validation** is marked pending upstream; it works against docker-jitsi-meet stable-11146-2
  (bot needs `https://` + hostname + a trusted cert).
- **Live Vexa STT backend wiring and two-speaker/late-joiner acceptance remain deferred follow-ups**:
  the shipped Compose still uses local Whisper inside Vexa. Tinfoil is wired only for the retained-recording
  recovery path described above. `fixtures/bob.wav` remains for the later live gate.
- The capture rig needed a host iptables fix (Docker's FORWARD/NAT chains had been flushed) — see infra/README.md.

## Vexa fork ([TinyCloudLabs/vexa](https://github.com/TinyCloudLabs/vexa))

The CVM runs commit-addressed bot, meeting-api, and gateway images from our Vexa fork. For Google Meet,
Vexa durably captures bounded speaker-attributed audio ranges and timing while live STT is disabled.
After the meeting, this service sends speech-sized attributed ranges to Tinfoil for text only, then
publishes the transcript with Vexa's speaker ownership and timestamps. A mixed whole-recording Tinfoil
transcript is never promoted as the canonical diarized result. The remaining Vexa components stay on
their unchanged upstream v0.12 images.

- **Branches**: `tinycloud` = current upstream (`59e2c413`) + the selected TinyCloud overlay, currently
  at `36f03047`. `main` tracks upstream untouched. The separate local rig remains pinned by
  `infra/vexa/upstream` and `infra/vexa/UPSTREAM_PIN` until that fixture is refreshed.
- **The patch**: `core/meetings/modules/record-chunker` — `createRecordingTap` builds a dynamic mix
  (`DynamicElementMixer`): the recorder starts immediately (even with zero audio elements) and a 2 s
  rescan (live-mixer parity) attaches new elements / detaches ended ones. Pinned by the module's
  `dynamic-tap.smoke.test.ts`.
- **Images**: bot, meeting-api, and gateway use
  `ghcr.io/tinycloudlabs/vexa/<component>:tc-36f0304`. The release commit includes the accepted runtime
  changes plus the workflow's missing pnpm toolchain correction. All are pinned by digest in
  `infra/dstack/app-compose.yaml`. The bot workflow is `tinycloud-bot-image`; the older
  `ghcr.io/tinycloudlabs/vexa-bot` package was created while the fork was private, is stuck private,
  and is deprecated — nothing pushes to it);
  the local rig layers the dev CA on top (`infra/vexa/bot/Dockerfile` → `ptx/vexa-bot:tc-devca`). Admin,
  runtime, and agent images stay on upstream `vexaai/v012-*:v012`, with their exact registry digests
  pinned. The agent images are configured for the runtime but are not used by the meeting capture path.
- **Syncing upstream** (in the fork repo): `git fetch upstream --tags && git checkout main && git merge
  --ff-only upstream/main && git push origin main --tags`, then rebase/merge `tinycloud` onto `main`,
  re-run the record-chunker tests, push, and bump this repo's submodule pin + bot image tag.
- License unchanged: Apache-2.0, upstream `LICENSE` intact; changes marked per Apache-2.0 §4(b).

## Deploy (Phala/dstack)

`infra/dstack/app-compose.yaml` runs api + worker + postgres + redis and the pinned Vexa stack
(admin-api, runtime, meeting-api, gateway, valkey, postgres, MinIO, CPU whisper) in ONE CVM; only `:8080`
is published. Bot spawning needs `/var/run/docker.sock` mounted into Vexa's `runtime` (one container per
bot on the fixed `ptx-vexa` network). A one-shot `vexa-provision` job mints the Vexa API key at first boot.
`bot-image-keeper` (a no-op container on the fork bot image `ghcr.io/tinycloudlabs/vexa/bot`,
overridable via `PTX_BOT_IMAGE`) makes compose pull the bot image and pins it:
Vexa's runtime does `docker create` without pulling, and dstack runs `docker image prune -af` after every
`compose up`, so without a referencing container the bot image is pruned and every meeting fails with
`provider_unavailable` ("No such image: …/vexa/bot:tc-<sha>").
If the docker.sock bind is ever refused by the platform, the alternative is Vexa's process backend
("Vexa Lite": bot as a sibling service / in-process instead of docker-spawned containers).

**Workspace.** Deploy from a Phala Cloud workspace you control (`phala switch <profile>` and confirm with
`phala status` before touching anything); the examples below use a CVM named `ptx-dev`.

**Image.** The api/worker image is `ghcr.io/tinycloudlabs/tinycloud-private-transcription/api` (`:<git sha>`
immutable, `:v1` moving on feat/v1 + main, `:latest` on main), built for linux/amd64 and pushed by the
GitHub Actions workflow `.github/workflows/publish-image.yml` on every push to `feat/v1` / `main` that touches
the Dockerfile, `src/`, or the lockfile (or `gh workflow run publish-image.yml`). It authenticates with the
workflow's `GITHUB_TOKEN` (`packages: write`); watch it with `gh run watch` and take the digest from the run
summary. Production defaults use the full `:<sha>@sha256:<digest>` reference from the accepted workflow;
when advancing them, update the immutable API/worker and Signal-seat references directly in
`infra/dstack/app-compose.yaml`. They deliberately cannot be overridden by sealed environment values,
which prevents an old deployment env from silently selecting stale code. Do not use the moving `:v1`
or `:latest` tags for deployment. (The older package
`ghcr.io/tinycloudlabs/tinycloud-private-transcription` — no `/api`
suffix — was created while the repo was private, is stuck private, and is deprecated; nothing pushes to it.)

Every image referenced by the dstack compose file, including the bot and agent images selected by Vexa's
runtime, has an immutable digest. Postgres, Redis, Valkey, unchanged Vexa v0.12 components, CPU whisper, and the curl
helper use the exact public linux/amd64 image configs already running on `ptx-dev`. The configured-but-unused
Vexa agent images use the public `v012` manifest digests because no agent image is cached on the CVM. The
accepted API default comes from main commit `0c5b5ae1`; the unchanged Signal-seat default remains at
`c3cdff63`. The accepted Vexa images come from `36f03047`. Image override variables take complete
references and must remain digest-pinned.

MinIO is pinned to the exact releases running on `ptx-dev`: server
`RELEASE.2025-09-07T16-13-09Z` and client `RELEASE.2025-08-13T08-35-41Z`. Their public Quay manifest-list
digests match the images already cached by the CVM, so fresh pulls are deterministic without changing the
MinIO command, `/data` volume, health check, credentials, or initialization flow.

The CVM must be able to pull these images. dstack's pre-launch script runs `docker image prune -af` on every
boot and `docker compose pull` before `up`, so a pre-pulled image does not survive an update — the registry
itself has to be reachable. Two options for the private-transcription image:

1. **Public package (preferred, current setup).** A GHCR package created by a workflow inherits the repository's
   visibility at creation time (the `org.opencontainers.image.source` label links it to the repo). The `/api`
   package was created after the repo went public and is public; if it ever ends up private there is no REST
   endpoint to change it — flip it once in the UI: GitHub → org TinyCloudLabs → Packages →
   `tinycloud-private-transcription/api` → Package settings → Danger Zone → Change visibility → Public. Verify
   with `sudo docker logout ghcr.io && sudo docker manifest inspect ghcr.io/tinycloudlabs/tinycloud-private-transcription/api:v1`.
2. **Sealed pull credentials.** Add `DSTACK_DOCKER_REGISTRY=ghcr.io`, `DSTACK_DOCKER_USERNAME=<github user>`,
   `DSTACK_DOCKER_PASSWORD=<PAT with read:packages only>` to `infra/dstack/.env`; the pre-launch script does
   `docker login ghcr.io` with them before pulling. Do not use a broad-scope OAuth/PAT here.

**Development fallback (no registry access, expires in 24 h)** — anonymous ttl.sh push from the dev host:

```bash
git archive HEAD Dockerfile package.json bun.lock src drizzle.config.ts tsconfig.json | tar -x -C /tmp/ptx-build
sudo docker build --platform linux/amd64 -t ttl.sh/ptx-api-$(git rev-parse --short HEAD):24h /tmp/ptx-build
sudo docker push ttl.sh/ptx-api-$(git rev-parse --short HEAD):24h
```
This is for a local compose edit only; production pins must remain immutable GHCR references committed to
`app-compose.yaml`. Containers already running keep their image across restarts, but a redeploy after expiry
cannot re-pull a ttl.sh image.

**Env.** `cp infra/dstack/.env.example infra/dstack/.env` (gitignored) and fill it: random 32-char values for
`POSTGRES_PASSWORD`, `VEXA_DB_PASSWORD`, `VEXA_ADMIN_TOKEN`, `VEXA_INTERNAL_API_SECRET`, `MINIO_ROOT_PASSWORD`;
keep `TRANSCRIPTION_PROVIDER=vexa`, and set `TINFOIL_API_KEY` to enable retained-recording recovery.
Everything in that
file is encrypted client-side and sealed into
the CVM (`phala deploy -e`); nothing secret lives in `app-compose.yaml`.

**Signal three-seat rig.** `signal-capture`, `signal-capture-2`, and `signal-capture-3` are headless
Signal Desktop images with Xvfb, PulseAudio/`parec`, noVNC, and one Bun capture worker each. Every seat
has its own network namespace, loopback-only CDP, private control token, readiness volume, and persistent
profile. PTX routes durable `seatN.<session>` IDs over three private control networks; no capture/CDP port
is public. noVNC is host-loopback-only on ports `6080`, `6081`, and `6082` for SSH-tunnel bootstrap. The
existing `signal-profile` volume remains seat 1, while `signal-profile-2` and `signal-profile-3` start
unlinked. Link each seat manually, preferably to a distinct Signal identity for reliable simultaneous
calls, then confirm `/health` reports ready with capacity `0/3`. A missing linked profile, display host,
or audio source is an environment gate, not evidence of a passed Signal call. TinyChat needs no change:
its existing `POST /v1/meetings` proxy accepts Signal URLs once production enables `signal`.

**Deploy / update.**

```bash
phala status                                                    # confirm the intended workspace
sudo docker compose -f infra/dstack/app-compose.yaml --env-file infra/dstack/.env config -q   # compose sanity
phala deploy -n ptx-dev -c infra/dstack/app-compose.yaml -e infra/dstack/.env -t tdx.large --disk-size 40G --wait
phala cvms get ptx-dev --json | jq '{status, app_id, gateway}'
# update in place (new image tag / env / compose):
phala deploy --cvm-id ptx-dev -c infra/dstack/app-compose.yaml -e infra/dstack/.env --wait
```

`tdx.large` (4 vCPU / 8 GB, ~$0.24/h incl. 40 GB disk) fits the control plane, Whisper small.en, and three
idle Signal Desktop seats. Treat three simultaneous captures/transcriptions as unpromoted until the live
three-call benchmark passes; Whisper may serialize CPU-heavy completion work. First boot takes ~5–10 min
(Vexa images ≈ 3.6 GB bot image + whisper model download).

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


### Diagnosing an unexpected bot departure

Read `capture` from `GET /v1/meetings/{id}`. Keep it alongside transcript status: a completed
transcript can be retained after an interrupted call. `left_alone` is a detector verdict,
not proof that participants stopped speaking. `evicted` is a removal-detector verdict, not proof
that a person removed the bot. `stopped` can include a runtime termination signal; compare it
with `stop_requested_by` rather than assuming the user pressed Stop. Exit 137 alone does not
prove an out-of-memory kill; confirm runtime events.

`capture.failure_reason` preserves explicit `browser_crashed` or `browser_closed` evidence from
a failed provider, including after transcript salvage. It contains only that discriminator;
private provider error text is not exposed. Older provider builds may omit it.

Search structured worker logs by `meetingId`: `bot dispatched` ties it to the bot/container and
provider meeting IDs and captures the timeout/mode; `capture status observed` carries lifecycle
evidence; `capture heartbeat` shows continued successful polling; `meeting status changed`
connects capture with transcript finalization. Capture health is explicitly `not_reported` by this
API. For continuous-speech incidents, correlate provider bot logs for:

- `aloneness: silence verdict` (last detected audio time and silence window)
- `Google Meet removal detected` (which selector matched)
- `termination signal` and runtime/container exit events
- `[PerSpeaker]` frame-flow/worklet/context logs

The pinned Google Meet detector currently accepts generic alert dialogs and `Reconnecting` as
removal indicators. Also, its audio-ready flag is cleared only during capture teardown; stalled
capture can remain marked ready. These are code-level failure mechanisms, not a diagnosis of
any particular meeting without its matching logs.

The CVM compose file waits for the API's healthcheck before starting the worker. The API's
`AUTO_MIGRATE` path applies every ordered migration through `0007_retain_legacy_transcript_state`
before listening, so this gate prevents the worker from querying the Signal columns before migration
completes. The physical `meetings.transcription_attempts`, `transcripts.fallback_from`, and
`transcripts.fallback_reason` columns are deprecated and retained only for rollback to the
pre-native-ingestion image; current code deliberately omits them from its ORM schema and public
responses. For workers started outside this compose file, run `bun run db:migrate` first. This
cleanup does not reconstruct historical evidence or add diarization.
