# TinyCloud Private Transcription API — V1 Spec

Repo: `TinyCloudLabs/tinycloud-private-transcription`.
Origin: Conclave × TinyCloud integration for the Zcash demo. Public API is **ours**; Vexa is an internal, replaceable meeting-capture implementation.

## Goal
Client sends a meeting URL → bot joins → client tracks state → client receives a speaker-attributed structured transcript.
Consumers: TinyCloud (`listen` app) and Conclave-shaped clients.

## Decisions (2026-08-17)
- Stack: **Bun + TypeScript** (Hono API + worker), Postgres, Redis queue. Vexa runs as a pinned upstream Docker Compose dependency (Apache-2.0, `Vexa-ai/vexa` main). Do not fork Vexa unless Jitsi live-join is broken; if forking is required, raise it before doing so.
- V1 transcript source: Vexa native transcription (WhisperLive, CPU mode — no GPU on dev host). TinyCloud validates, normalizes, and stores Vexa-produced segments; it does not download recordings or perform a second transcription pass.
- E2E test: local `docker-jitsi-meet` + Playwright fake participant that joins the room and plays a known TTS/WAV clip; assert transcript contains expected phrases with a speaker label. Public meet.jit.si needs an authenticated moderator → not used for automated tests.
- dstack/Phala: write the dstack app-compose; **attempt** a dev CVM deploy with the authenticated `phala` CLI in a dedicated workspace; never touch unrelated production CVMs. Small spend OK; stop and report on anything larger.
- Auth: static project API keys (`tc_live_…`, hashed in Postgres), seeded via CLI; single project for demo. Leave room for scopes.
- Multi-tenancy: one Vexa user/token owned by the service; our API does project scoping. Don't mirror projects into Vexa.
- Ship order (happy-path-first):
  1. Stock Vexa locally, bot into local Jitsi room, transcript via Vexa's own API.
  2. API + worker + Postgres: `POST /v1/meetings`, `GET /v1/meetings/{id}`, `POST /v1/meetings/{id}/stop`, `POST /v1/meetings/{id}/recover`, `GET /v1/meetings/{id}/transcript`, `DELETE /v1/meetings/{id}` (also deletes in Vexa). Own IDs (`mtg_…`), own error taxonomy, platform detection from URL.
  3. `meeting.completed` + `meeting.failed` webhooks (HMAC-SHA256 `X-Webhook-Signature`, retries immediate/1m/5m/30m/2h; webhook failure never fails the meeting), `Idempotency-Key`.
  4. dstack compose + Phala dev CVM attempt.

## API
Auth: `Authorization: Bearer tc_live_xxx`. A missing, malformed or unknown key → `401 unauthorized`.

Scopes: each authenticated route group requires exactly one scope on the key; otherwise `403`
`{"error":{"type":"authentication_error","code":"insufficient_scope","message":"…"}}`. Scopes are exact strings (the `:*`
suffix is naming only): there is no global wildcard and no prefix matching, so `*`, `meetings` or `meetings:read` grant nothing.
Routing is deny-by-default: every `/v1` request is authenticated and then authorized against the registered groups
below; a `/v1` path outside them answers `404 not_found` even for a valid key.

| Scope | Routes |
|---|---|
| `meetings:*` | `/v1/meetings*` |
| `transcriptions:*` | `/v1/transcriptions*` (batch role only; see [Batch transcription](#batch-transcription-ptx_rolebatch)) |
| `admin:*` | `/v1/admin/*` (batch role only) |

Keys minted without explicit scopes get `meetings:*`; every key that existed before enforcement holds it (migration 0016).
Keys come from `create-key [--scopes …]` or, on CVMs without SSH, the sealed `PTX_BOOTSTRAP_KEYS` env (hashes only).

`POST /v1/meetings` body: `meeting_url` (required), `bot_name`, `language`, `webhook_url`, `platform` (override), `metadata` (opaque, echoed everywhere). Returns immediately:
```json
{"id":"mtg_01K…","object":"meeting","status":"queued","platform":"jitsi","meeting_url":"…","created_at":"…","metadata":{}}
```
States: `queued → joining → waiting_for_admission → in_progress → processing → completed`; terminal failures `failed`, `cancelled`. `in_progress` only once the bot is actually admitted. Map from Vexa statuses (`requested/joining/awaiting_admission/active/needs_help/stopping/completed/failed`; `awaiting_admission`/`needs_help` → `waiting_for_admission`). A meeting still `joining`/`waiting_for_admission` `JOIN_TIMEOUT_SECONDS` (default 600) after bot dispatch is failed by the worker (`meeting_join_failed`/`waiting_room_timeout`), the bot stopped, and `meeting.failed` emitted.

For every dispatched meeting, the worker sends Vexa `automatic_leave.max_time_left_alone` from `VEXA_MAX_TIME_LEFT_ALONE_MS` (default 300000 milliseconds). Vexa currently infers aloneness from the absence of remote participant audio, so five continuous silent minutes release the bot and continue normal finalization as `completed(left_alone)` on Jitsi or Google Meet; operators can tune the window when needed.

`GET /v1/meetings/{id}` → status, platform, bot{name,joined_at}, transcript{status}, created/started/ended_at, metadata, error{type,code,message} on failure. Once completed it includes `transcript_provider: "vexa"`.

`GET /v1/meetings/by-idempotency-key` with an `Idempotency-Key` header → `{meeting, request_hash}` for the authenticated project's existing create, or `404 meeting_not_found`. `meeting` has the same shape as the ID lookup; `request_hash` is SHA-256 of the canonical parsed create body (sorted object keys, omitted undefined fields, preserved array order; Signal URL fragments removed). This endpoint only reads: it never creates a meeting or enqueues work. Use it to recover uncertain creates even when sending another bot is no longer authorized. A lookup miss is not proof that a still-running request cannot commit later.
`POST /v1/meetings/{id}/stop` → idempotent, returns `{id,status}`.

`POST /v1/meetings/{id}/recover` → tenant-scoped, idempotently moves a failed meeting with a retained
capture-provider record back to `processing` and retries Vexa-segment finalization.
`GET /v1/meetings/{id}/transcript` → 202 `{meeting_id,status}` until complete; then
```json
{"meeting_id":"…","status":"completed","language":"en","duration_seconds":0,"provider":"vexa",
 "speakers":[{"id":"speaker_0","name":"Alice"}],
 "segments":[{"id":"seg_001","speaker_id":"speaker_0","speaker_name":"Alice","start":0.0,"end":3.2,"text":"…"}],
 "text":"Alice: …","created_at":"…"}
```
`speaker_id` is stable within a meeting only. `provider` is `"vexa"`: Vexa owns the transcript and speaker attribution, while TinyCloud normalizes the completed segments. `DELETE /v1/meetings/{id}` removes our record + transcript and the Vexa meeting.
`GET /health` → `{status:"ok","checks":{postgres,redis,vexa,bot_capacity:{running,max},transcription_provider}}` (`bot_capacity.max` from `VEXA_MAX_CONCURRENT_BOTS`).

Errors: `{"error":{"type":"meeting_join_failed","code":"waiting_room_timeout","message":"…"}}`. Codes: invalid_meeting_url, unsupported_platform, meeting_not_found, meeting_join_failed, waiting_room_timeout, bot_removed, meeting_ended, capture_failed, transcription_failed, provider_timeout, provider_unavailable, internal_error (+ request-level `unauthorized` 401, `insufficient_scope` 403, `invalid_request`, `idempotency_conflict`). Never leak Vexa errors raw.

Platform detection: meet.google.com→google_meet, zoom.us→zoom, teams.microsoft.com→microsoft_teams, meet.jit.si / self-hosted Jitsi→jitsi. Only platforms in `ENABLED_PLATFORMS` (default `jitsi`) are accepted; a detected-but-disabled platform answers 400 `unsupported_platform` naming the platform.

Webhook event: `{"id":"evt_…","type":"meeting.completed","created_at":"…","data":{"meeting_id":"…","metadata":{},"transcript_provider":"vexa"}}` (`data.error` on `meeting.failed`).

## Batch transcription (`PTX_ROLE=batch`)

A separate service built from the same image. `PTX_ROLE` defaults to `meeting`, which mounts none of the routes below
and never runs the batch worker; `PTX_ROLE=batch` mounts only these routes (no `/v1/meetings`) and builds no Redis,
Vexa or Signal client. The batch provider credential is its own variable, `BATCH_TINFOIL_API_KEY`; without it the
service answers `503 service_unavailable` to every create. Worker: `bun run src/uploads/worker.ts` (refuses to start
unless `PTX_ROLE=batch`). Migration 0017 only adds tables.

### Endpoints
All `/v1/transcriptions*` routes need `transcriptions:*` and an `X-Tenant-Ref` header (64 lowercase hex; the caller's
HMAC of its user id: PTX never sees a user identity). Every read, cancel and delete is tenant-scoped: a missing,
other-tenant or deleted job is the same `404 transcription_not_found`.

```http
POST /v1/transcriptions   Idempotency-Key: <1..200 printable ASCII>   X-Tenant-Ref   X-Correlation-Id?
{"content_type":"audio/mpeg|audio/wav|audio/ogg","byte_size":1..120960000,"sha256":"<64 hex>",
 "language":"en"?, "channel_mode":"separate|mixed"?, "channel_labels":["Speaker 1","Speaker 2"]?}
→ 201 new | 200 replay (same key + same body + same tenant): <job> + "upload":{"path":"/uploads/trn_…","capability":"tcu_…","expires_at","max_live":5}
  ("upload" is present only while the job is awaiting_upload; each replay issues one more capability and revokes none)
GET  /v1/transcriptions?limit=1..100            {"object":"list","data":[<job>…]} newest first
GET  /v1/transcriptions/by-idempotency-key      <job> (read-only; issues no capability)
GET  /v1/transcriptions/{id}                    <job>
GET  /v1/transcriptions/{id}/result             202 {id,status} | 200 completed transcript | 200 {id,status:"failed"|"cancelled",error} | 410 transcript_expired
POST /v1/transcriptions/{id}/cancel             {id,status} (idempotent)
DELETE /v1/transcriptions/{id}                  204; the job is gone from every read at once
GET  /v1/transcriptions/capabilities            {max_bytes,max_duration_seconds:7200,max_channels:2,content_types,transcript_ttl_seconds:86400,admission,ready}
PUT  /uploads/{id}   Authorization: Bearer <capability>   Content-Length = byte_size   Content-Type = content_type
GET|PUT /v1/admin/admission  (admin:*)          {"mode":"open|drain|closed"} → {mode, active:{awaiting_upload,queued,processing}, retention_lag_seconds}
```
`<job>` = `{id, object:"transcription", status, content_type, byte_size, language, channel_mode, channel_labels,
duration_seconds, channels, progress:{stage, queue_position, regions_completed, regions_total}, retention:{audio:
not_received|stored|deletion_pending|deleted, audio_deleted_at, transcript_expires_at, transcript_deleted_at},
error:{type,code,message}|null, created_at, upload_deadline_at, uploaded_at, processing_started_at, finished_at}`.
Completed result: `{id, status, language, duration_seconds, provider:"tinfoil", model, channels, speakers:[{id:
"channel_N", name, channel}], segments:[{id, speaker_id, channel, start, end, text}], text, stats:{tinfoil_calls,
tinfoil_audio_seconds}}`. Timestamps are region-level (VAD regions, below).

States: `awaiting_upload → queued → processing → completed`; terminal `failed` and `cancelled`.

### Admission (atomic, all in one transaction on the admission row lock)
- Admission `mode` must be `open` (`drain`: no creates, uploads and processing continue; `closed`: no creates, no
  uploads, no new claims) → else `503 service_paused`.
- One active job (`awaiting_upload`/`queued`/`processing`) per tenant → `409 active_transcription_exists {id}`; a
  partial unique index enforces the same in the database.
- Service-wide reservation over the same active set: at most `BATCH_MAX_ACTIVE_JOBS` jobs and
  `BATCH_MAX_RESERVED_BYTES` declared bytes → `429 service_busy`. The job row is the reservation; only a terminal
  transition releases it. Since every upload is capped at its declared size and the worker processes one job at a
  time, this also bounds temp + accepted audio on disk.
- Upload volume at or above `BATCH_DISK_HIGH_WATER_PERCENT` → `429 service_busy` for creates and PUTs (alert log).
- Tenant daily bytes (UTC day), charged at create by a conditional `UPDATE` → `429 quota_exceeded`.
- No live worker heartbeat (30 s) or no provider credential → `503 service_unavailable`.
All 429/503 answers carry `retry_after_seconds` and `Retry-After`.

### Upload
The capability is 32 random bytes (`tcu_…`), stored as sha256, compared in constant time, valid only for
`PUT /uploads/{its job}` with that job's declared length, type and hash, for min(60 min, the job's upload deadline);
it grants no read. The job's upload deadline is create + 2 h, after which it fails `upload_expired`. One PUT at a
time per job (a DB lease: `409 upload_in_progress`) and at most `BATCH_MAX_CONCURRENT_UPLOADS` service-wide
(`429 service_busy`). A PUT is cut off (`408 upload_interrupted`, job unchanged) when: no bytes arrive for 60 s;
its average rate is below `BATCH_UPLOAD_MIN_BYTES_PER_SECOND` after 60 s; or it passes its hard expiry,
min(start + `BATCH_UPLOAD_MAX_PUT_SECONDS`, the upload deadline). Lease heartbeats never move the hard expiry. A body that
ends early or errors is also `408 upload_interrupted`; a wrong `Content-Length` is `400 upload_length_mismatch`; a wrong
`Content-Type` is `415 unsupported_media_type`. The bytes are streamed to a temp file while hashed, then verified
(sha256, then ffprobe: one audio stream of the declared container, 1–2 channels, ≤ 7,200 s), renamed, and committed.
Validation failures end the job: `422 upload_rejected {status:"failed", job_error:{code: upload_integrity_failed |
invalid_audio | unsupported_recording | recording_too_long}}`.

**Post-acceptance contract (the only one).** `201 {"status":"queued"}` is returned only after the transaction that moves
the job to `queued` has committed; that same transaction deletes every capability of the job. Any later PUT, including a
replay after a lost 201, gets `401 upload_capability_invalid` and changes nothing. There is no "already received"
answer. After a transport error or any non-201 answer, the client's only authority is `GET /v1/transcriptions/{id}`:
`awaiting_upload` → upload the whole file again (with a live capability or a fresh one from an idempotent create
replay); anything else → the upload was accepted or the job ended.

### Processing
One job end-to-end at a time, service-wide. Per channel (`separate` + 2 channels; otherwise a mono downmix), ffmpeg
decodes to 16 kHz PCM on disk; an energy VAD (100 ms frames; voiced ≥ max(−50 dBFS, p10 + 12 dB); gaps ≤ 1 s merged;
±0.25 s padding; regions > 30 s split at the quietest frame in their last 10 s) produces regions; each region is one
Tinfoil request. No speech → `no_speech`.

**Exactly-once dispatch.** A single-row slot table is the arbiter: in one transaction the worker proves its claim, takes
the slot and commits a `started` attempt; only then is the request sent, with no await in between. At most one provider
request is in flight at any time. Outcomes:

| Outcome | Action |
|---|---|
| 200 with text | region completed |
| 429 | new attempt after `Retry-After` (default 30 s, max 120 s); 20 consecutive → `provider_unavailable` |
| provably not sent (connection refused / DNS / TLS verification) | ≤ 5 attempts with backoff → `provider_unavailable` |
| 400 / 413 / 415 / 422 | `transcription_failed` |
| 401 / 403 / 404 | `provider_unavailable` + alert (operator fault) |
| timeout, reset, 5xx, other status, unparseable body, worker died while admitted | attempt `ambiguous`, **never re-sent** → `provider_outcome_unknown` |

A worker that dies before any admission is requeued (regions and completed results kept; ≤ 3 claims → `processing_failed`).
A job processing longer than 4 h fails `processing_timeout`.

**Fencing.** Every claim bumps the job's `generation` and gets a random claim token. Every worker write (stage
transitions, region inserts, region text, counters, result assembly, terminal commit) is a compare-and-swap on
`status='processing'` + claim token + generation + `tombstoned=false`, and row-locks the job for its transaction.
Cancel, delete and the processing timeout bump the generation in the transaction that ends the job. A fenced-out worker
stops, writes no content (a late provider response is recorded only as a `discarded` attempt), and re-runs cleanup. Job
directories are only ever created by an upload holding a live lease and never recursively, so a fenced-out worker cannot
recreate deleted artifacts.

### Retention
Every terminal transition commits `deletion_state='pending'` together with the terminal state, before any file is
unlinked; the audio, PCM and temp files are then removed and verified absent (`ENOENT`) before `files_deleted` is
recorded. `DELETE` cancels an active job, deletes transcript content and hides the job in the same transaction, and keeps
a content-free tombstone (ids, tenant ref, sizes, timings, codes). A sweeper (every 60 s) retries pending deletions,
expires unaccepted uploads, times out processing, recovers dead claims, deletes transcripts 24 h after completion,
removes any artifact the ledger does not authorize (alerting if one reappears after verified deletion), and purges
finished rows 7 days after their files were verified deleted. `/health` reports `retention_lag_seconds` (age of the
oldest pending deletion) and is `degraded` past 300 s. Deleted data may remain on storage media until overwritten.

### Errors and correlation
Every response has `X-Correlation-Id` (the caller's, if 1–128 of `[A-Za-z0-9._:-]`, else a new UUID). Every error body is
`{"error":{"type","code","message","correlation_id", …}}`. Request codes: `invalid_request`, `unauthorized`,
`insufficient_scope`, `idempotency_conflict`, `transcription_not_found`, `active_transcription_exists`,
`recording_too_large` (413), `quota_exceeded`, `service_busy`, `upload_capability_limit` (429), `service_paused`,
`service_unavailable` (503), `upload_capability_invalid` (401), `upload_capability_expired` (410),
`upload_length_mismatch` (400), `unsupported_media_type` (415), `upload_in_progress` (409), `upload_interrupted`
(408), `upload_rejected` (422), `transcript_expired` (410), `not_found`, `internal_error`. Job `error.code`:
`upload_expired`, `upload_integrity_failed`, `invalid_audio`, `recording_too_long`, `unsupported_recording`,
`no_speech`, `provider_unavailable`, `provider_outcome_unknown`, `processing_timeout`, `processing_failed`,
`transcription_failed`, `cancelled`. Logs carry ids, codes and correlation ids only: never the tenant ref, a
capability, audio or text.

`GET /health` (batch) → `{status, checks:{postgres, upload_transcription:{ready, provider_configured, worker_live,
admission, active, retention_lag_seconds, disk:{used_percent, high_water_percent}}}}`, 503 unless `ok`.
`/health/live` checks Postgres only.

## Capture diagnostics

Meeting reads and transcript responses include an optional `capture` object. Completed/failed
webhooks include the same evidence. It is service-owned, stored in `meetings.capture_diagnostics`,
and separate from caller-supplied `metadata`. Existing rows without evidence omit it.

`capture` contains the dispatched `silence_timeout_ms`, live-transcription request flag,
provider meeting ID and status, `completion_reason`, `failure_stage`, `exit_code` when reported,
provider start/end timestamps, observation timestamp, segment counts, and up to 20
sanitized status transitions. `stop_requested_at`/`stop_requested_by` record our stop intent
(`user` or `join_deadline`); they do not replace the provider's actual departure reason.
`provider_record_missing_at` records a provider 404.

`failure_reason` is optional and currently allowlists `browser_crashed` and `browser_closed`.
It is retained only when a failed provider reports that discriminator, without copying the raw
error text. It can coexist with a completed, salvaged transcript and remains available if a later
provider response omits it. An exit code alone does not infer a browser crash or an OOM kill.

These fields describe capture independently of transcript success: `status: "completed"` can
coexist with `capture.completion_reason: "evicted"` or `"left_alone"` after successful salvage.
Missing reasons/exit codes remain null. Unrecognized provider enums become `unknown`.
`audio_activity: "not_reported"` explicitly means the upstream API does not report PCM arrival
or AudioContext health; zero transcript segments are not evidence of silence.

Only operational fields are retained. Provider logs, error text, recording URLs, participant names,
and conversation content are excluded. Access uses the existing project/meeting authorization.
Capture observations are persisted/logged on provider status/reason/exit-code changes and at most
once per minute otherwise while polling. Terminal evidence survives transcription retries.

## Persistence (Postgres)
`meetings(id, project_id, meeting_url, platform, status, bot_name, vexa_native_meeting_id, vexa_bot_id, created_at, started_at, ended_at, completed_at, metadata, capture_diagnostics, error_code, error_message, idempotency_key)`
`transcripts(meeting_id, language, duration_seconds, segments_json, provider, created_at)`
`webhook_deliveries(id, meeting_id, event_type, endpoint, attempt, status, response_code, created_at)`
`api_keys(id, project_id, key_hash, scopes, bootstrap_managed, created_at)`
Batch role only (migration 0017): `transcriptions`, `transcription_capabilities`, `transcription_regions`,
`transcription_attempts`, `transcription_results`, `provider_dispatch_slots` (one row), `transcription_tenant_usage`,
`transcription_admission` (one row), `transcription_workers`.

## Deployment
Meeting service: single dstack CVM: api, worker, Vexa services, redis, postgres. Batch transcription runs as its own
service (`PTX_ROLE=batch`: api, `src/uploads/worker.ts`, postgres) with its own Tinfoil credential.

## Non-goals (V1)
Summaries, chat/RAG, agents, calendar UI, user accounts, team workspaces, transcript approval/versioning, voice fingerprints, dashboards, realtime WS events (V2: `WS /v1/meetings/{id}/events`), replacing the Vexa UI.

## Definition of done
`curl -X POST /v1/meetings -d '{"meeting_url":"<local jitsi room>"}'` → `{"id":"mtg_…","status":"queued"}`; fake participant speaks; `GET /v1/meetings/{id}` reaches `completed`; `GET …/transcript` returns speakers/segments/text containing the expected phrase; `meeting.completed` webhook delivered and signature-verified. All exercised by an automated E2E test in the repo.
