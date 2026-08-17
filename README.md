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
infra/dstack/       app-compose.yaml draft for the Phala/dstack CVM
```

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

`bun test` runs everything (needs the dev Postgres/Redis; the mock Vexa is started in-process).

### Env vars

| var | default | notes |
|---|---|---|
| `PORT` | `8080` | API port |
| `DATABASE_URL` | `postgres://ptx:ptx@localhost:55432/ptx` | |
| `REDIS_URL` | `redis://localhost:56379` | queue |
| `VEXA_BASE_URL` | `http://localhost:18056` | Vexa API gateway |
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

# delete (also deletes the Vexa meeting) → 204
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

## Vexa mapping (re-type against the real JSON when the stack is up)

Types in `src/providers/vexa/types.ts` come from Vexa's frozen OpenAPI (`core/gateway/contracts/api.v1/api.schema.json`, v1.5.0):

- `POST /bots` `{platform, native_meeting_id, meeting_url, bot_name, language}` → `MeetingResponse` (201). Vexa platform for Teams is `teams` (ours: `microsoft_teams`). Self-hosted Jitsi native id is `room@host`; `meeting_url` is passed through (Vexa requires https, non-IP hosts).
- `GET /transcripts/{platform}/{native_meeting_id}` → `{status, segments[{start,end,text,language,speaker,completed}], data.completion_reason?}` — the worker polls this for both status and segments.
- `DELETE /bots/{platform}/{native_meeting_id}` → stop; `DELETE /meetings/{platform}/{native_meeting_id}` → delete data.
- Status map: `requested|joining→joining`, `awaiting_admission|needs_human_help→waiting_for_admission`, `active→in_progress`, `stopping|completed→processing` (then `completed` once our transcript is stored), `failed→failed`; `completion_reason` → our error codes (`src/domain/state.ts`).
- **GUESS**: `/recordings` shape (untyped upstream) used only for the Tinfoil batch path (`fetchVexaAudio` in `src/worker/meeting-job.ts`). Whether `recording_enabled` persists audio is unverified.
