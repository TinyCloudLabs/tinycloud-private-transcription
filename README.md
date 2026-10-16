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
cp .env.example .env                                     # untracked (gitignored)
perl -pi -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env   # your own dev DB secret
sudo docker compose -f docker-compose.dev.yml up -d      # Postgres 127.0.0.1:55432, Redis 127.0.0.1:56379
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
src/roles/          PTX_ROLE=batch context, app and API process
src/uploads/        batch transcription: jobs API, capability upload, admission, worker, arbiter, VAD, deletion ledger
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
cp .env.example .env                                     # untracked (gitignored); compose and Bun both read it
perl -pi -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
sudo docker compose -f docker-compose.dev.yml up -d      # Postgres 127.0.0.1:55432, Redis 127.0.0.1:56379

# 1) a Vexa: the real stack (VEXA_BASE_URL/VEXA_API_KEY) or the built-in mock
VEXA_API_KEY=vxa_mock bun run mock-vexa                  # http://localhost:18056

# 2) API + worker (in two shells; both read .env / process env)
VEXA_API_KEY=vxa_mock bun run api                        # migrates, listens on :8080
VEXA_API_KEY=vxa_mock bun run worker

# 3) mint an API key (printed once; only the sha256 hash is stored)
bun run cli create-key --project demo                       # scopes default to meetings:*
bun run cli create-key --project demo --scopes 'transcriptions:*'   # quote: zsh globs a bare *
```

No database password is committed (TC-929): each developer generates their own `POSTGRES_PASSWORD` as above and
keeps it only in the untracked `.env`, from which `DATABASE_URL` is built. `DATABASE_URL` has no default; the API,
worker and CLI refuse to start without it. On a shared, internet-facing host, bind dev ports to `127.0.0.1` (Docker
publishes a bare `HOST:CONTAINER` port on every interface, past ufw); `docker-compose.dev.yml` already does.

### API-key scopes

Every authenticated route group requires one exact scope, or it answers `403 insufficient_scope`:
`meetings:*` for `/v1/meetings*`, `transcriptions:*` for `/v1/transcriptions*` and `admin:*` for `/v1/admin/*` (the
last two exist only in the batch role, below). There is no global wildcard. `create-key` defaults to `meetings:*`, which every
pre-existing key holds, so meeting callers need no change. `--scopes` takes a comma-separated list.

On a CVM without SSH, set the sealed env `PTX_BOOTSTRAP_KEYS` to a JSON array of `{id, project, scopes, sha256}`
(hashes only). At boot the API makes exactly those the bootstrap-managed keys: new ids are inserted, a changed hash
rotates that key, and bootstrap ids missing from the array are revoked. Keys from `create-key` are never touched. Unset
means no bootstrap management; `[]` revokes all bootstrap keys. Mint entries offline (prints each plaintext key once):

```bash
bun run scripts/mint-bootstrap-keys.ts --key 'tinychat-batch:tinychat:transcriptions:*' --key 'owner-admin:ops:admin:*'
```

`bun test` runs unit + integration (needs the dev Postgres/Redis; the mock Vexa is started in-process).
`bun run test:e2e` runs the REAL happy path (`test/e2e/happy-path.test.ts`, skipped unless `E2E=1`) against
the capture rig — it brings up nothing itself: follow [infra/README.md](./infra/README.md) first, then
run it; it mints a Vexa key via admin-api, starts api+worker in-process, creates a meeting in a random
`https://jitsi.local:8443/<room>`, sends Alice, waits for `completed`, checks transcript + signed webhook,
then deletes. The test uses `E2E_AUTO_LEAVE_MS` (default `60000`) so it does not wait for the five-minute
production window. Green 2/2 on 2026-08-17 (~2 min each; evidence in `tmp/e2e-<room>.json`).

### Batch transcription role

`PTX_ROLE=batch` runs the batch-transcription service from the same image (contract: [SPEC.md](./SPEC.md#batch-transcription-ptx_rolebatch)).
It needs only Postgres, ffmpeg and (for `diarize: true`) the bundled sherpa-onnx diarization program; it never talks to Vexa,
Redis or Signal, and it mounts no meeting route. The meeting role (default) mounts none of its routes.

```bash
export PTX_ROLE=batch BATCH_UPLOAD_DIR=$PWD/tmp/uploads BATCH_TINFOIL_API_KEY=…   # a dedicated batch credential
bun run api                       # migrates; serves /health, /v1/transcriptions*, /v1/admin/*, PUT /uploads/{id}
bun run src/uploads/worker.ts     # one job at a time; one provider request at a time
bun run cli create-key --project tinychat --scopes 'transcriptions:*'
```

| var (batch role) | default | notes |
|---|---|---|
| `PTX_ROLE` | `meeting` | `batch` selects this service; anything else fails boot |
| `BATCH_TINFOIL_API_KEY` | – | the batch service's own Tinfoil key; `TINFOIL_API_KEY` is never read in this role. Unset = every create answers `503 service_unavailable` |
| `BATCH_TINFOIL_BASE_URL` / `BATCH_TINFOIL_MODEL` / `BATCH_TINFOIL_TIMEOUT_MS` | `https://inference.tinfoil.sh` / `voxtral-small-24b` / `180000` | |
| `BATCH_UPLOAD_DIR` | `/var/lib/ptx-batch/uploads` | accepted audio, in-flight uploads, PCM work files (both processes mount it) |
| `BATCH_VAD_QUIET_MODE` | `true` | trimmed, case-insensitive `false` rolls back quiet detection to TC-1090's primary/−57 dBFS fallback paths; unknown non-empty values enable quiet mode with a warning naming the variable; set on the batch worker |
| `BATCH_MAX_ACTIVE_JOBS` | `10` | service-wide awaiting_upload + queued + processing |
| `BATCH_MAX_RESERVED_BYTES` | `1209600000` | service-wide declared bytes of those jobs (10 × the 120,960,000-byte cap) |
| `BATCH_MAX_CONCURRENT_UPLOADS` | `3` | service-wide live PUTs |
| `BATCH_DISK_HIGH_WATER_PERCENT` | `80` | creates and PUTs refused at or above this volume usage |
| `BATCH_TENANT_DAILY_BYTES` | `362880000` | per tenant per UTC day (3 × cap) |
| `BATCH_UPLOAD_MAX_PUT_SECONDS` | `1800` | absolute cap on one PUT (also clamped to the job's 2 h upload deadline) |
| `BATCH_UPLOAD_MIN_BYTES_PER_SECOND` | `32768` | minimum average PUT rate after 60 s |
| `BATCH_CORS_ORIGINS` | unset | comma-separated browser origins allowed to `PUT /uploads/{id}` directly (exact, or one leading `*.` label, e.g. `https://*.tinychat-4jq.pages.dev`); unset = no CORS headers; a malformed entry fails boot |
| `BATCH_DIARIZATION_ENABLED` | `false` | `true` offers speaker diarization (`capabilities.diarization`, create `diarize: true`) when the install below is complete; set it on both processes. Benchmark and sizing: [docs/diarization-benchmark.md](./docs/diarization-benchmark.md) |
| `BATCH_DIARIZATION_DIR` | `/opt/sherpa-onnx` | the image's sherpa-onnx install: `diarize` (launcher of `src/uploads/diarize-window.c`), `models/segmentation.onnx`, `models/embedding.onnx`, `models/onnxruntime.config` |
| `PTX_FAULT_INJECT` | unset | staging-only fault injection (`<point>:<crash|error|delay=<ms>>,…`); must never be set in a deploy |

### Env vars

| var | default | notes |
|---|---|---|
| `PORT` | `8080` | API port |
| `DATABASE_URL` | – (required) | Postgres URL. Locally `postgres://ptx:${POSTGRES_PASSWORD}@localhost:55432/ptx` from `.env` (see `.env.example`); no default is committed (TC-929) |
| `REDIS_URL` | `redis://localhost:56379` | queue |
| `VEXA_BASE_URL` | `http://localhost:18066` | Vexa API gateway (capture rig). Mock: `http://localhost:18056` |
| `VEXA_API_KEY` | – | sent as `X-API-Key` |
| `VEXA_POLL_INTERVAL_MS` | `5000` | worker status/transcript poll |
| `VEXA_MAX_TIME_LEFT_ALONE_MS` | `300000` | per-meeting window without remote participant audio (milliseconds). After five minutes without hearing anyone else, Vexa completes the bot as `left_alone`; applies to Jitsi and Google Meet. |
| `VEXA_MAX_CONCURRENT_BOTS` | `2` | concurrent meeting-bot cap (TC-902): a non-Signal `POST /v1/meetings` over it answers 429 `capacity_exhausted`; reported as `bot_capacity.max` in `/health`. The dstack compose also defaults it to `2` and applies it to the Vexa user's `max_concurrent_bots` at every boot |
| `VEXA_CAPACITY_RETRY_INTERVAL_MS` | `10000` | a Vexa 429 at bot start (its `max_concurrent_bots`, e.g. a leaving bot it still counts) is retried at this interval while the meeting stays `queued` |
| `VEXA_CAPACITY_RETRY_WINDOW_MS` | `120000` | how long after creation those retries continue before the meeting fails with `capacity_exhausted` |
| `ENABLED_PLATFORMS` | `jitsi` | comma-separated platforms accepted by `POST /v1/meetings`. Others (zoom, google_meet, microsoft_teams) are still detected but answer 400 `unsupported_platform` |
| `SIGNAL_CAPTURE_URLS` | `http://127.0.0.1:18076` | ordered capture-worker endpoints, one per persistent Signal Desktop seat |
| `SIGNAL_CAPTURE_TOKEN_PATHS` | none | ordered private control-token files; required for non-loopback capture endpoints |
| `SIGNAL_CAPABILITY_KEY` | none | required only outside dstack; dstack self-provisions a durable private-volume key used to encrypt Signal call URL fragments at rest |
| `SIGNAL_MAX_CONCURRENT_CALLS` | `1` | provisioned Signal Desktop seat count; production compose pins `1` |
| `SIGNAL_PULSE_SOURCE` | `ptx_sink.monitor` in dstack | PulseAudio monitor captured by the isolated Signal seat |
| `SIGNAL_TRANSCRIBER` | bundled dstack adapter | local WAV-to-JSON adapter using the in-CVM Whisper service |
| `JOIN_TIMEOUT_SECONDS` | `600` | worker-side join deadline: a meeting still `joining`/`waiting_for_admission` this long after bot dispatch is failed (`meeting_join_failed`/`waiting_room_timeout`), its bot stopped, and `meeting.failed` emitted |
| `TRANSCRIPTION_PROVIDER` | `vexa` | Compatibility label; Vexa remains the primary provider and is reported by health. |
| `TINFOIL_BASE_URL` | `https://inference.tinfoil.sh` | OpenAI-compatible confidential transcription endpoint used only for recovery. |
| `TINFOIL_API_KEY` | – | bearer token; when set, enables recording retention and recovery transcription. |
| `TINFOIL_MODEL` | `voxtral-small-24b` | recovery transcription model. |
| `AUTO_MIGRATE` | `true` | API runs migrations at boot |
| `PTX_BOOTSTRAP_KEYS` | unset | sealed JSON array of hashed API keys the API syncs at boot (see API-key scopes) |
| `LOG_LEVEL` | `info` | JSON logs |

### Realtime request correlation and logging gate (TC-959)

The meeting API accepts a canonical UUID `X-Request-Id` (RFC variant, versions 1–8), lowercases it,
or mints v4 when missing/invalid. Every response echoes it, including 401/403/404/500. Queue payloads
carry `requestId`; the worker restores an isolated async scope before dispatch and retries retain that
local ID. **No outbound HTTP request-ID forwarding is enabled:** Vexa/Google, Tinfoil, generic webhooks
and Signal receive no `X-Request-Id`, including across redirects. A configured Signal URL is not proof
of first-party ownership or fail-closed redirect handling, so it is excluded too. Provider correlation
is not claimed. Any future forwarding requires an explicit owned first-party origin and a redirect
policy that cannot disclose the ID to another origin.

A legacy/reconciled job without an ID mints a new worker ID; Redis wakeup loss does not preserve a
durable meeting-wide trace. Batch `X-Correlation-Id`, uploads, CORS, provider dispatch and transcription
contracts are unchanged. No account/space pseudonym or common HMAC key is introduced.

At `LOG_LEVEL=info` (or `debug`), the API emits one `ptx_realtime_request` event per completed request
and the worker one `ptx_realtime_worker` event per dispatched job, including errors. Both have fixed
`ts`, `level=info`, `msg` (equal to the event name), `event`, lowercase UUID `request_id`, boolean
`request_id_replaced`, and integer `duration_ms` clamped to 0–86,400,000. Replacement is evaluated at
each boundary: true only for a rejected incoming/persisted ID, false for a valid ID or an absent ID
that was minted. Rejected text is never included. Canonical UUID vectors are vendored from N0 in
`test/fixtures/request-id-vectors.json`. Event-specific fields:

| Event | Fields |
| --- | --- |
| `ptx_realtime_request` | `method`: GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS or OTHER; `route`: registered health/meeting template or `unmatched`; numeric HTTP `status` |
| `ptx_realtime_worker` | `job_type`: meeting.start/meeting.poll/meeting.join_deadline/attributed.batch/attributed.finalize/webhook.deliver/eval.meeting or `unknown`; `outcome`: processed/noop/deferred/error |

Neither event includes request/response payloads, raw URI/query, meeting URL, native meeting ID,
tenant/account identity, token, provider response or exception text. The existing general logger and
dependency/console output are **not** made universally safe by these events.

Delayed-job deduplication ignores request metadata: the first pending work+dedup-suffix entry retains
its original payload, ID and due time. Push and each promotion/cancellation batch atomically maintain
selected-payload and work indexes. Existing raw `JSON|suffix` entries remain readable; resumable legacy
indexing selects the earliest due duplicate (lexical tie-break), repairs old/partially failed indexes,
and preserves the selected raw payload.

Migration, due promotion and work-targeted cancellation visit at most **64 entries per Redis EVAL**.
Migration/cancellation continue across awaited calls; their total duration still scales with backlog.
Promotion moves at most 64 healthy jobs per call and leaves remaining due work for subsequent calls.
The row cap bounds work per script, not a production latency SLA or a byte-size limit. Index reset uses
`UNLINK` so freeing a large old index is not performed inside the blocking script.

Protected decoding isolates malformed delayed JSON, primitive/array payloads and missing separators
instead of aborting Lua after earlier mutations. Invalid members retain their original bytes and due
score in the private `<prefix>:jobs:delayed:invalid` sorted set when encountered during migration or due
promotion. They are not enqueued or logged. Inspect only its `ZCARD` count in routine diagnostics; never
ship or print quarantined payloads. Healthy work continues, and cancellation reads the work index rather
than decoding unrelated future members. `Queue.clear()` explicitly clears indexes/quarantine too.

Local real-Redis smoke verified 1,000 legacy jobs migrate in 16 pages plus one push EVAL, 1,001 due jobs
promote in 16 batches, and 1,000 matching jobs cancel in 16 batches while an unrelated job survives.
A connection failure after a committed 64-row migration page resumes without losing healthy work.
These are synthetic local checks, not production throughput or real-sink evidence.

Cutover must quiesce old queue writers; mixed old/new writers are not supported. After an old-writer
rollback epoch, rebuild the identity indexes under the same quiescence gate before roll-forward.

**Code-only; not a shipping enablement.** No image pins, Compose, Vector, credentials or production
settings change here. Before ptx-dev shipping, separately review the canonical schema and a fail-closed
Vector gate accepting only these typed API/worker JSON events/fields: drop unknown/unlabelled/nested/
malformed/free-text input and all raw Vexa admin/runtime, uvicorn and Signal stdout/stderr. Require
native gate tests, real-sink forbidden-value canaries with positive controls, volume/event-loss checks
and rollback evidence. API/worker image promotion and any sidecar/Compose update require separate
operator authorization under TC-1264/TC-965 and the zero-bot window; this PR does not lift those gates.

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

When some captured audio is missing, a speaker is unknown, or the transcript was recovered from the mixed recording, `GET /v1/meetings/{id}` and `meeting.completed` also carry `"transcript_partial": true` (and the transcript body carries `"partial": true`).

### Errors

`{"error":{"type":"meeting_join_failed","code":"waiting_room_timeout","message":"…"}}`. Codes:
`invalid_meeting_url, unsupported_platform, meeting_not_found, meeting_join_failed, waiting_room_timeout,
bot_removed, meeting_ended, capture_failed, transcription_failed, provider_timeout, provider_unavailable,
internal_error` (+ `unauthorized`, `insufficient_scope`, `invalid_request`, `idempotency_conflict`). Vexa errors are never forwarded raw.

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
diarization: recovered segments have null speaker names and `attribution: "unknown"`, with a stable,
non-null speaker ID and no placeholder participant or speaker label. `POST /v1/meetings/{id}/recover` remains tenant-scoped;
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
  at `78e5ae24` (TC-560 attributed-audio retry on top of `36f03047`). `main` tracks upstream untouched. The separate local rig remains pinned by
  `infra/vexa/upstream` and `infra/vexa/UPSTREAM_PIN` until that fixture is refreshed.
- **The patch**: `core/meetings/modules/record-chunker` — `createRecordingTap` builds a dynamic mix
  (`DynamicElementMixer`): the recorder starts immediately (even with zero audio elements) and a 2 s
  rescan (live-mixer parity) attaches new elements / detaches ended ones. Pinned by the module's
  `dynamic-tap.smoke.test.ts`.
- **Images**: meeting-api uses `ghcr.io/tinycloudlabs/vexa/meeting-api:tc-c8d7f33` (TC-583: per-range table, stop-then-start deploys only) and gateway uses `ghcr.io/tinycloudlabs/vexa/gateway:tc-36f0304`; the bot
  uses `ghcr.io/tinycloudlabs/vexa/bot:tc-e5b5307` (TC-560, TC-582, TC-903). The release commit includes the accepted runtime
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

The batch-transcription service is a separate CVM (`ptx-batch`), deployed only by the manual
`.github/workflows/deploy-batch.yml`; see [infra/dstack-batch/README.md](./infra/dstack-batch/README.md). Everything below
is the meeting service (`ptx-dev`).

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
`RELEASE.2025-09-07T16-13-09Z` and client `RELEASE.2025-08-13T08-35-41Z`. quay.io no longer serves MinIO's
community images anonymously, so both are mirrored to `ghcr.io/tinycloudlabs/mirror/minio` and
`ghcr.io/tinycloudlabs/mirror/minio-mc`, copied from the images cached on the CVM (`docker save`). The mirror
re-serialises the layers, so its manifest digests differ from Quay's; the image config digests (Docker image
IDs `sha256:69b2ec20…` for the server and `sha256:c2ad7742…` for the client) and the layer diff_ids are
unchanged. The MinIO command, `/data` volume, health check, credentials, and initialization flow are unchanged.

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

**Signal seat.** `signal-capture` is a headless Signal Desktop image with Xvfb, PulseAudio/`parec`, noVNC,
and a Bun capture worker. The seat has its own network namespace, loopback-only CDP, private control token,
readiness volume, and persistent profile (`signal-profile`). PTX routes durable `seat1.<session>` IDs over a
private control network; no capture/CDP port is public. noVNC is host-loopback-only on port `6080` for
SSH-tunnel bootstrap. Link the seat manually, then confirm `/health` reports ready with capacity `0/1`. A
second simultaneous Signal call waits for the seat. The rig supports more seats (one `SIGNAL_CAPTURE_URLS`
entry each); seats 2 and 3 were removed in TC-901 because they were never linked and cost ~800 MB idle. A missing linked profile, display host,
or audio source is an environment gate, not evidence of a passed Signal call. TinyChat needs no change:
its existing `POST /v1/meetings` proxy accepts Signal URLs once production enables `signal`.

**Deploy / update.**

```bash
phala status                                                    # confirm the intended workspace
sudo docker compose -f infra/dstack/app-compose.yaml --env-file infra/dstack/.env config -q   # compose sanity
phala deploy -n ptx-dev -c infra/dstack/app-compose.yaml -e infra/dstack/.env -t tdx.large --disk-size 40G --no-public-logs --no-public-sysinfo --wait
phala cvms get ptx-dev --json | jq '{status, app_id, gateway}'
# update in place (new image tag / env / compose):
phala deploy --cvm-id ptx-dev -c infra/dstack/app-compose.yaml -e infra/dstack/.env --no-public-logs --no-public-sysinfo --wait
```

`tdx.large` (4 vCPU / 7.5 GB usable, ~$0.24/h incl. 40 GB disk) fits the control plane, one Signal seat, an
on-demand Whisper small.en, and two Google Meet bots (`VEXA_MAX_CONCURRENT_BOTS=2`; each bot is ~1-1.2 GB). Whisper
unloads its model after 5 idle minutes (`WHISPER__TTL=300`) and lazy-loads it again in ~4-8 s. A third concurrent
bot request answers 429 `capacity_exhausted`; raise the cap only together with the CVM size (TC-900). First boot takes ~5–10 min
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

### API-key scopes: first deploy and rollback

Migration `0016_api_key_scopes` (first image with scope enforcement) appends `meetings:*` to every existing key
that lacks it, so callers keep their meeting access. Before that deploy, record which keys it will touch; on
ptx-dev, the same query must return no rows afterwards:

```bash
phala ssh ptx-dev -- -i ~/.ssh/id_ed25519 "docker exec dstack-postgres-1 psql -U ptx -d ptx -c \"SELECT id, project_id, scopes FROM api_keys WHERE array_position(scopes, 'meetings:*') IS NULL\""
```

**Rollback = redeploy the previous compose (previous image digest) only.** 0016 is additive: the older image never
reads or writes `bootstrap_managed`, ignores scopes, and keeps minting and authenticating keys against the migrated
schema (covered by `migration-upgrade.test.ts`). Do **not** revert 0016 or strip scopes: a backfilled `meetings:*` is
indistinguishable from a minted one, and removing it locks those keys out when enforcement returns. While rolled
back, `PTX_BOOTSTRAP_KEYS` is not synced, so removing an id from it does not revoke that key until roll-forward.


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

Vexa bot log redaction is not active in the currently pinned image. The Vexa #16 changes must land,
then the bot image must be rebuilt and re-pinned in ptx. Only after those steps, and behind the
ptx-dev shipper allowlist, should Vexa logs be treated as scrubbed. The shipper allowlist remains
the enforcement boundary. Google Meet admission diagnostics are opt-in through `DEBUG_ADMISSION`;
the deployed compose does not set it, and the dump itself is count-only.

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
