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
States: `queued → joining → waiting_for_admission → in_progress → processing → completed`; terminal failures `failed`, `cancelled`. `needs_help` is a pre-admission state alongside `waiting_for_admission`. `in_progress` only once the bot is actually admitted. Map from Vexa statuses (`requested/joining/awaiting_admission/active/needs_help/needs_human_help/stopping/completed/failed`; `awaiting_admission` → `waiting_for_admission`; `needs_help`/`needs_human_help` → `needs_help`). The join clock starts at the first poll that observes a raw Vexa `joining`, `awaiting_admission`, `needs_help`, or `needs_human_help`; `requested` does not start it. The clock is stored in the `meeting_join_clocks` table (one row per meeting: `join_observed_at`, `join_deadline_at`, `dispatch_fallback_at`), so restarts do not reset it. A meeting still open at `join_deadline_at` is failed by the worker (`meeting_join_failed`/`waiting_room_timeout`), the bot stopped, and `meeting.failed` emitted. `JOIN_TIMEOUT_SECONDS` (default 600) sets the deadline from the first observation. Before any observation, the deadline is `JOIN_DISPATCH_FALLBACK_SECONDS` (default 900) after dispatch. While in `needs_help`, the deadline is `JOIN_NEEDS_HELP_MAX_SECONDS` (default 1200) after the first observation; after leaving `needs_help`, `join_deadline_at` applies again. While `needs_help`, `status_message` is `The notetaker is stuck joining`. A meeting already `in_progress` is not affected by the deadline. Vexa's `needs_help` reason is read from `meeting.data.escalation_reason` and stored as `escalation_reason` in capture diagnostics while the bot is `needs_help`/`needs_human_help`. It is restricted to Vexa's 9-value enum; any other value is stored as `unknown`, and the stored value persists after the bot leaves `needs_help`.

`NEEDS_HELP_STATE_ENABLED` (default `false`) controls only the client-visible `needs_help` state. When `false`, the API, webhooks, and transcript responses report `waiting_for_admission` in place of `needs_help` and omit `escalation_reason`; the bot stays held until `JOIN_NEEDS_HELP_MAX_SECONDS`, and the join clock still reads the raw Vexa status.

For every dispatched meeting, the worker sends Vexa `automatic_leave.max_time_left_alone` from `VEXA_MAX_TIME_LEFT_ALONE_MS` (default 300000 milliseconds). Vexa currently infers aloneness from the absence of remote participant audio, so five continuous silent minutes release the bot and continue normal finalization as `completed(left_alone)` on Jitsi or Google Meet; operators can tune the window when needed.

`GET /v1/meetings/{id}` → status, platform, bot{name,joined_at}, transcript{status,version}, created/started/ended_at, metadata, error{type,code,message} on failure. Once completed it includes `transcript_provider: "vexa"`.

`transcript.version`: integer, starts at 1, strictly increases each time the meeting's transcript is replaced (republish or rollback). Present when a transcript row exists. The transcript GET also includes `version` and `published_at` (ISO timestamp, falling back to `created_at` for legacy publications).

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
Speaker contract (TC-981): only segment `speaker_name` is nullable (`string | null`);
`speaker_id` remains a non-null string. Unattributed speech has `speaker_name: null` and
`attribution:"unknown"`, with an opaque ID of `participant:unresolved:<opaque>`.
Segment ids (`seg_…`), speaker ids (`speaker_…`) and unresolved speaker keys are stable only within one published version of a meeting's transcript. A republish (an increase in `transcript.version`) may renumber them, so consumers must key anything derived from them by (meeting id, `transcript.version`).
They are not derived readably from provider data. Consumers must not parse them. Unresolved IDs use
1-based ordinals assigned by first appearance in the final time-ordered segment list, so rerunning
the same input produces identical IDs. Speech without a capture key shares one unresolved ID,
separate from keyed voices. Explicit `attribution:"overlap"` is retained for overlapping speech.
It creates no entry in `speakers[]`, and its plain-text line contains only the speech text,
without a speaker label. Named speakers, including a participant actually named `Unknown`,
keep their names and speaker entries. The existing attribution field remains optional for
named segments. Gap `speaker_name` is also nullable when its speaker could not be resolved.
This is an API contract change: consumers must accept null names. Deploy the separate
tinychat consumer null-handling PR before deploying this PTX change. Existing stored
transcripts are unchanged until `republish` (TC-989) publishes them in the null-name/opaque-id
shape as a new transcript version.

Attributed Google Meet transcripts (`provider:"tinfoil-attributed"`) are turn-level: each speaker
stream is transcribed with a timestamped model (`TINFOIL_ATTRIBUTED_MODEL`, Whisper) and every segment
is placed on the meeting clock, so speakers interleave in spoken order. A participant has one
`speaker_id` per display name. Audio whose speaker the capture could not bind takes the name of the
bound speaker on the same audio channel within 3 s, with `attribution:"provisional"`; otherwise it
publishes with `speaker_name: null` and `attribution:"unknown"`. Model output that is not speech (chat-assistant replies, stock captions on
silence, repetition loops) is dropped. Audio below −65 dBFS never yields text (silent windows are not
even sent); energy is measured over the captured audio within ±1 s of the text, never over pauses
inserted between ranges. Speech-level audio (≥ −45 dBFS) keeps short phrases unless the model's
confidence is very low: possible noise is preferred over lost speech.

No captured speech is silently lost (TC-758). A batch whose Tinfoil call was uncertain (transport
error, timeout), returned no words (or only text the filter drops), or failed, and a range fetch that
failed, is retried after `ATTRIBUTED_RETRY_BACKOFF_MS` (default 30 s, 1 m, 2 m, 4 m, 8 m: six tries);
a possible duplicate provider charge is accepted. Every paid try is its own durable attempt under the
same fence as before (claim token, dispatch slot, owner heartbeat). An attempt never runs past 8 min,
so a retry after a dead worker waits out that bound and two calls for one batch never overlap; a
worker that dies while preparing (e.g. killed during a download) spends the same six-try budget.
After two empty results (no kept words from voiced audio) the batch stops retrying: its speech is
gap-filled from the recording or listed as a gap, never sent to another model (TC-2118). A row whose
attempts already reach the limit (e.g. after the schedule was shortened) settles exhausted. Batch
and gap-fill calls run in two background worker slots, so other meetings' jobs are never held up.
Publication waits for scheduled retries and accepts a batch whose latest attempt succeeded after only
failed/uncertain ones, or whose attempts are all failed/uncertain.

Speech still untranscribed — exhausted batches, producer-failed ranges, and the parts of completed
batches that yielded no kept text (a voiced window answered empty, text dropped over non-silent
audio) — is re-read from Vexa's retained mixed recording. One unpaid step streams the recording into
100 ms levels and aligns it to the meeting clock: the recording starts when the bot's capture starts
(about Vexa's `start_time`) while the clock origin is its first audible frame, so
`clock_origin_ms − start_time` only centres the search (±30 s; −5…600 s without it). Each offset
is scored by the Pearson correlation between the manifest's speech indicator and the recording's
voiced 100 ms frames, which still discriminates when someone is talking almost all the time. An
offset is used only for a prominent peak: r ≥ 0.3, z ≥ 6 against the offsets outside its own ±1.5 s
lobe, and ≥ 0.1 above the best of them. Without a verified alignment nothing is sent and every span
is a listed gap.
Voiced windows (≤ 29 s each) are then transcribed in paid groups of ≤ 4 windows, each group its own
retried attempt ledger, so a failure loses only that group's work. Levels and cuts come from one
decode path (`aresample=async=1`, which fills container-timestamp gaps; cuts by decoded sample
offset, never `-ss`), so they share one clock; a cut whose measured 100 ms envelope does not match
the one alignment planned is not sent and its window is listed as a gap. The recording is downloaded
once per meeting (a download shorter than its `content-length` is retried, never cached) to a
worker-local cache removed when the meeting publishes or fails; a deleted meeting's cache is removed
by the worker's sweep within about a minute;
unpaid preparation renews its claim so a slow download is not mistaken for a crash, and one
meeting's gap fill holds at most one of the two background slots. `bun run cli gapfill-check
--meeting <id|vexa id> [--windows N] [--all]` runs the alignment and a few cuts against a real
recording and prints the correlation peak (best offset, r, z, runner-up, prior) and planned vs
measured energy, sending nothing to Tinfoil.
Recovered text publishes with `source:"recording"` under the speaker of that speech with
`attribution:"provisional"`; unresolved speech takes the same-channel inference (provisional) or
`speaker_name: null` with `attribution:"unknown"`. Anything still untranscribed — and any gap-fill result that
fails verification, which never fails the meeting — is listed as `gaps: [{start, end, speaker_name}]`
(meeting seconds) with `partial: true`; a meeting with gaps but no text still completes with them
listed. The worker logs `untranscribed_gap` with the gap total. Publication is typically minutes
after the meeting; when every attempt times out at its deadline, batch retries and the recording
fill together can delay it by about 1.5–2 h.
`partial: true` is added when the transcript degraded: unresolved-speaker ranges published under an
unknown speaker, speech filled from the recording or listed as gaps, or the mixed recording recovered
because the attributed manifest could not be staged. `GET /v1/meetings/{id}` and `meeting.completed`
webhooks then also carry `transcript_partial: true`.
`speaker_id` is stable within a meeting only. `provider` is `"vexa"`: Vexa owns the transcript and speaker attribution, while TinyCloud normalizes the completed segments. `DELETE /v1/meetings/{id}` removes our record + transcript and the Vexa meeting.
`GET /health` → `{status:"ok","checks":{postgres,redis,vexa,bot_capacity:{running,max},transcription_provider}}` (`bot_capacity.max` from `VEXA_MAX_CONCURRENT_BOTS`).

Bot cap (TC-902): `POST /v1/meetings` for any non-Signal platform answers `429 capacity_exhausted` (type
`provider_error`, `Retry-After: 60`, `retry_after_seconds: 60`) when `VEXA_MAX_CONCURRENT_BOTS` meetings are already
queued, joining, waiting for admission or in progress. Admission is serialized, nothing is stored for a rejected
request, and an `Idempotency-Key` replay of an admitted request is still answered. If Vexa itself refuses a bot
(its user's `max_concurrent_bots`), the worker retries every `VEXA_CAPACITY_RETRY_INTERVAL_MS` (10 s) while the meeting
stays `queued`, and fails it with `capacity_exhausted` only after `VEXA_CAPACITY_RETRY_WINDOW_MS` (2 min) from creation. Signal calls instead wait for a
free Desktop seat (`SIGNAL_MAX_CONCURRENT_CALLS`).

Errors: `{"error":{"type":"meeting_join_failed","code":"waiting_room_timeout","message":"…"}}`. Codes: invalid_meeting_url, unsupported_platform, meeting_not_found, meeting_join_failed, meeting_already_captured (type `meeting_join_failed`: Vexa refused the bot because another live meeting from this service, in any project, is already capturing the same call; the message never names it), waiting_room_timeout, bot_removed, meeting_ended, capture_failed, transcription_failed, provider_timeout, provider_unavailable, capacity_exhausted (429), internal_error (+ request-level `unauthorized` 401, `insufficient_scope` 403, `invalid_request`, `idempotency_conflict`). Never leak Vexa errors raw.

Platform detection: meet.google.com→google_meet, zoom.us→zoom, teams.microsoft.com→microsoft_teams, meet.jit.si / self-hosted Jitsi→jitsi. Only platforms in `ENABLED_PLATFORMS` (default `jitsi`) are accepted; a detected-but-disabled platform answers 400 `unsupported_platform` naming the platform.

Internal evaluation (operator only, never served by the API): with `EVAL_MODELS` set, the worker
re-transcribes eligible completed attributed meetings (owners in `EVAL_TINYCHAT_ADDRESSES`, or all with
`EVAL_ALL_MEETINGS=true`) with each model from the retained audio and stores the results in
`transcript_evals`. `bun run cli eval reference|run|report|show` stores a reference transcript (e.g. a
Google Meet/Gemini export), runs evals on demand, and prints metrics (WER in published order, word and
trigram recall, speaker accuracy, unknown share, hallucinated turns) for the published transcript and
every eval. `eval report` also prints the meeting's coverage (captured vs transcribed speech ms,
split into attributed, recording-filled, silent and gap ms), stored with the canonical transcript in
`attributed_transcription_runs.coverage_json`. Eval and reference rows are deleted with the meeting.

Webhook event: `{"id":"evt_…","type":"meeting.completed","created_at":"…","data":{"meeting_id":"…","metadata":{},"transcript_provider":"vexa"}}` (`data.error` on `meeting.failed`).

## Batch transcription (`PTX_ROLE=batch`)

A separate service built from the same image. `PTX_ROLE` defaults to `meeting`, which mounts none of the routes below
and never runs the batch worker; `PTX_ROLE=batch` mounts only these routes (no `/v1/meetings`) and builds no Redis,
Vexa or Signal client. The batch provider credential is its own variable, `BATCH_TINFOIL_API_KEY`; without it the
service answers `503 service_unavailable` to every create. Worker: `bun run src/uploads/worker.ts` (refuses to start
unless `PTX_ROLE=batch`). Migration 0017 only adds tables.

### Endpoints
All `/v1/transcriptions*` routes need `transcriptions:*`. All of them except `GET /v1/transcriptions/capabilities`
(service-wide limits, not about any job) also need an `X-Tenant-Ref` header (64 lowercase hex; the caller's HMAC of its
user id: PTX never sees a user identity). Every read, cancel and delete is tenant-scoped: a missing,
other-tenant or deleted job is the same `404 transcription_not_found`.

```http
POST /v1/transcriptions   Idempotency-Key: <1..200 printable ASCII>   X-Tenant-Ref   X-Correlation-Id?
{"content_type":"audio/mpeg|audio/wav|audio/ogg|audio/mp4|audio/webm|audio/flac","byte_size":1..186496800,"sha256":"<64 hex>",
 "language":"en"?, "channel_mode":"separate|mixed"?, "channel_labels":["Speaker 1","Speaker 2"]?, "diarize":false?}
→ 201 new | 200 replay (same key + same body + same tenant): <job> + "upload":{"path":"/uploads/trn_…","capability":"tcu_…","expires_at","max_live":5}
  ("upload" is present only while the job is awaiting_upload; each replay issues one more capability and revokes none)
GET  /v1/transcriptions?limit=1..100            {"object":"list","data":[<job>…]} newest first
GET  /v1/transcriptions/by-idempotency-key      <job> (read-only; issues no capability)
GET  /v1/transcriptions/{id}                    <job>
GET  /v1/transcriptions/{id}/result             202 {id,status} | 200 completed transcript | 200 {id,status:"failed"|"cancelled",error} | 410 transcript_expired
POST /v1/transcriptions/{id}/cancel             {id,status} (idempotent)
DELETE /v1/transcriptions/{id}                  204; the job is gone from every read at once
GET  /v1/transcriptions/capabilities            {max_bytes:186496800,max_duration_seconds:10800,accepted_max_duration_seconds:11101,max_channels:2,content_types,diarization,transcript_ttl_seconds:86400,admission,ready}
PUT  /uploads/{id}   Authorization: Bearer <capability>   Content-Length = byte_size   Content-Type = content_type
GET|PUT /v1/admin/admission  (admin:*)          {"mode":"open|drain|closed"} → {mode, active:{awaiting_upload,queued,processing}, retention_lag_seconds}
```
`<job>` = `{id, object:"transcription", status, provider_delayed?:true, content_type, byte_size, language, channel_mode,
channel_labels, diarize, duration_seconds, channels, progress:{stage, queue_position, regions_completed, regions_total}, retention:{audio:
not_received|stored|deletion_pending|deleted, audio_deleted_at, transcript_expires_at, transcript_deleted_at},
error:{type,code,message}|null, created_at, upload_deadline_at, uploaded_at, processing_started_at, finished_at}`.
Completed result: `{id, status, language, duration_seconds, provider:"tinfoil", model, channels, diarized, speakers:[{id,
name, channel}], segments:[{id, speaker_id, channel, start, end, text}], text, stats:{tinfoil_calls,
tinfoil_audio_seconds, voiced_seconds, dropped_above_floor_pct, vad_fallback, vad_mode, noise_floor_dbfs, median_dbfs,
p99_dbfs, speech_peak_s, dropped_above_noise_pct}}`. `voiced_seconds` is the audio the VAD (or
diarizer) selected to send, summed over channels (a `separate` stereo job can exceed `duration_seconds`);
`dropped_above_floor_pct` is the share of the non-silent audio (at or above −50 dBFS) that was not sent; `vad_fallback`
is true when the coverage guard (below) replaced the VAD threshold. The last two are null for a job whose regions were
detected before TC-1045. TC-1093 adds `vad_mode: "primary" | "fallback" | "quiet"`, `noise_floor_dbfs` (p10),
`median_dbfs` (p50), `p99_dbfs`, `speech_peak_s` (seconds of frames ≥ p10 + 21 dB), and `dropped_above_noise_pct`
(0–100: share of frames ≥ max(−65, p10 + 6) whose centres are unsent). All five numeric fields are finite numbers;
an empty input has p10/p50/p99 = −120 and zero counts. Percentiles use floor-index order statistics.
For separate stereo, scalar diagnostics pool the channel frames; `speech_peak_s` sums channel-frame duration and
can exceed wall-clock duration. The gate runs per channel; the job mode is quiet if any channel is quiet, otherwise
fallback if any falls back, otherwise primary. Diarized jobs retain known speaker turns and add the ordinary VAD's
selected quiet/fallback coverage, including fallback when the quiet gate misses or is disabled. Primary coverage
also repairs above-floor holes that exceed the guard. Mode/fallback match the ordinary selection; both drop metrics
describe the final sent turns, which must satisfy the same coverage bound before any provider dispatch.
These six additions are persisted with the regions and retained
across re-claims; they are absent for jobs detected before TC-1093. Existing saved results are returned unchanged.
Without `diarize`, `diarized` is false, speakers are `channel_N` (named by `channel_labels`) and
timestamps are region-level (VAD regions, below). With `diarize`, `diarized` is true, `channels` is 1, speakers are
`{id:"speaker_N", name:"Speaker N+1", channel:0}` (N 0–31, numbered by first appearance; only speakers with text are
listed) and every segment is one speaker turn on channel 0, in time order. Recovered audio without speaker evidence
uses the next available `speaker_N` id named `Unknown speaker`, after numbering known speakers by their own first
appearance. Unknown does not shift known speakers' ids or names. Recovered intervals shorter than 0.4 s that touch a turn
are absorbed into its nearest speaker (ties to the earlier turn). At the 32-speaker limit, added audio is attributed
to the nearest existing turn instead of adding an unknown speaker; a midpoint split that would create a piece shorter
than 0.4 s stays whole with the touching side (otherwise the nearest side). The exact union has no duplicate audio; requests
stay at most 30 s, including when a recovered sliver extends a capped turn. Results stored before `diarized` existed
are returned with `diarized: false`.

`content_type` → container: `audio/mpeg` mp3, `audio/wav` WAV, `audio/ogg` Ogg (Vorbis/Opus/FLAC), `audio/mp4`
MP4/M4A (any `mov,mp4,m4a` demux), `audio/webm` WebM/Matroska, `audio/flac` FLAC. `channel_mode` defaults to `separate`,
or to `mixed` when `diarize` is true; `diarize: true` with `channel_mode: "separate"` is `400 invalid_request`.
`capabilities.diarization` is true only when the diarization stage is installed and enabled; while it is false,
`diarize: true` is `400 diarization_unavailable` (nothing is created). `diarize: false` is not part of the idempotency
hash, so requests from before the field existed replay unchanged.

States: `awaiting_upload → queued → processing → completed`; terminal `failed` and `cancelled`.

### Admission (atomic, all in one transaction on the admission row lock)
- Admission `mode` must be `open` (`drain`: no creates, uploads and processing continue; `closed`: no creates, no
  uploads, no new claims) → else `503 service_paused`. `closed` also stops uploads already in flight: a streaming PUT
  is cut within one lease heartbeat (10 s), and no upload commits after the request that closes admission has
  returned (the commit takes a share lock on the admission row). The job stays `awaiting_upload`. A job already
  processing runs to its end. A fresh install starts `closed`; the deploy workflow opens it only after its gates pass.
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
`Content-Type` is `415 unsupported_media_type`. The bytes are streamed to a temp file while hashed, then verified:
sha256, then ffprobe (the container is the declared `content_type`'s, exactly one audio stream, 1–2 channels, raw duration ≤ 11,101 s;
video and data streams are ignored: never transcoded or transcribed). When the container carries no duration,
as browser MediaRecorder WebM does not, the length is the last audio packet's end minus the start time, measured within
45 s of wall clock (else `invalid_audio`); more packets than 11,101 s of 2.5 ms Opus frames is `recording_too_long`
whatever the timestamps say. The bytes are then renamed and committed. Validation failures end the job before any
provider call: `422 upload_rejected {status:"failed", job_error:{code: upload_integrity_failed | invalid_audio |
unsupported_recording | recording_too_long}}`. `invalid_audio` covers unreadable bytes, a container other than the
declared type (e.g. WAV bytes declared `audio/mp4`), and zero or several audio streams.

`max_duration_seconds=10800` is the nominal three-hour limit; `accepted_max_duration_seconds=11101` is the inclusive
raw ffprobe admission ceiling, compared **before** rounding stored duration to milliseconds. An exactly 11,100-second
decoded MP3 can report 11,100.029388 seconds because of encoder padding. This policy also admits about one second of
genuinely longer content beyond 11,100 seconds; it is not an exact decoded-content boundary. Capabilities emit no
`duration_grace_seconds`. The byte cap is inclusive for every container: `186496800` is accepted, `186496801` is
`413 recording_too_large` at create. Bun's HTTP body limit matches that cap; PUT still requires the declared length/hash.

Long-recording validation scope is **MP3/AAC only; WAV ≤ max_bytes** (AAC in MP4/M4A, declared `audio/mp4`). Generic
11,100-second AAC has admission-only evidence; actual mobile encoders and full AAC worker processing remain unverified.
A 16 kHz mono s16le WAV of that length is 355,200,078 bytes and fails the byte cap. Other advertised formats remain
accepted under the same limits, but long durationless WebM is unproven. See [TC-922 evidence](docs/tc-922-validation.md).

**Browser uploads (CORS).** `BATCH_CORS_ORIGINS` lists the origins allowed to `PUT /uploads/{id}` from a browser:
comma-separated exact origins (`scheme://host[:port]`, lowercase, no path), each optionally with one leading wildcard
label (`https://*.tinychat-4jq.pages.dev` matches `https://x.tinychat-4jq.pages.dev` only). A malformed entry fails
startup. Unset or empty: no CORS headers anywhere (the default). It applies to `/uploads/*` only: `OPTIONS` preflight
answers `204` with `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Methods: PUT, OPTIONS`,
`Access-Control-Allow-Headers: Authorization, Content-Type` and `Access-Control-Max-Age: 600`; the `PUT` and every error
it returns carry `Access-Control-Allow-Origin`. Every `/uploads/*` answer has `Vary: Origin`; credentials are never
allowed (the capability travels in `Authorization`). A disallowed origin gets no `Access-Control-Allow-Origin`.

**Post-acceptance contract (the only one).** `201 {"status":"queued"}` is returned only after the transaction that moves
the job to `queued` has committed; that same transaction deletes every capability of the job. Any later PUT, including a
replay after a lost 201, gets `401 upload_capability_invalid` and changes nothing. There is no "already received"
answer. After a transport error or any non-201 answer, the client's only authority is `GET /v1/transcriptions/{id}`:
`awaiting_upload` → upload the whole file again (with a live capability or a fresh one from an idempotent create
replay); anything else → the upload was accepted or the job ended.

### Processing
One job end-to-end at a time, service-wide. Per channel (`separate` + 2 channels; otherwise a mono downmix), ffmpeg
decodes to 16 kHz PCM on disk, stopping at the accepted 11,101 s of PCM (counted in bytes, whatever the timestamps say),
so the accepted tail beyond nominal 10,800 s reaches processing; an energy VAD
(100 ms frames; voiced ≥ max(−50 dBFS, min(−40 dBFS, p10 + 12 dB)); gaps ≤ 1 s merged;
±0.25 s padding; regions > 30 s split at the quietest frame in their last 10 s) produces regions; each region is one
Tinfoil request. No speech → `no_speech`. The −40 dBFS cap keeps continuous speech over a steady noise floor, where the
10th percentile lies inside the speech (TC-1045); a background louder than −40 dBFS is therefore sent with the speech.
**Coverage guard:** if the regions leave more than 10% of the channel's non-silent audio (frames at or above −50 dBFS)
unsent, or more than one minimum region (0.4 s) if that is larger, the channel's regions are recomputed with −57 dBFS as
the threshold (every non-silent stretch, merged, padded and cut at 30 s) and the job records `vad_fallback`; if even
those leave more than that unsent, the job fails `processing_failed` rather than completing with part of the recording.
A recording too short for any region still fails `no_speech`.

**Assistant-reply guard (TC-2119):** the batch model is an audio LLM and can answer a region like a chat assistant instead of
transcribing it. A region whose whole returned text is assistant boilerplate (`isAssistantReply` in `src/domain/hallucination.ts`:
at most 400 characters, built only from assistant phrases such as "thank you for your question", "I'm not sure what you're
referring to", "could you please provide more context", "as an AI language model", "I cannot transcribe", plus bare
connectives) completes with empty text, is not published, and is logged as `batch_region_ungrounded` with a count only. Text that
holds any other word is kept. A job whose regions are all dropped ends `no_speech`.

**Quiet mode:** when the median is below −50 dBFS, p99 is below −30 dBFS, and at least 1 s of 100 ms frames is
≥ p10 + 21 dB, build regions at min(−50, max(−65, p10 + 3)) with ±0.5 s padding. Send their exact union with the
primary/fallback regions above, coalesced and split at 30 s, so quiet mode never removes previously selected audio.
The absolute coverage guard still measures at −50 dBFS, and a quiet channel records `vad_fallback: false`.
Every non-quiet channel keeps the previous regions exactly. `BATCH_VAD_QUIET_MODE=false` disables the gate and
quiet constants for new detections, returning to TC-1090's primary/−57 fallback paths; additive stats remain available.

**Diarization** (`diarize: true`; [docs/diarization-benchmark.md](./docs/diarization-benchmark.md)). After the mono
decode, speech is labelled with speakers in equal windows of at most 10 min that overlap by 60 s, one window at a time,
each by its own child process (`src/uploads/diarize-window.c`: sherpa-onnx pyannote segmentation-3.0 + TitaNet-S
embeddings + clustering at threshold 1.0; killed when the claim is lost), so memory does not grow with the recording.
Each window reports its local speakers' segments and one voice embedding per local speaker. Local speakers are linked
to the recording's speakers in window order (constants in `DIARIZATION`, `src/uploads/diarize.ts`): a local speaker
joins the speaker with the best score ≥ 0.6, the score being the cosine similarity of its embedding to that speaker's
centroid plus 0.1 × the share of its overlap speech it shares with that speaker in the previous window (when ≥ 2 s);
each speaker takes one local speaker per window unless the score is ≥ 0.8; otherwise it is a new speaker. Centroids are
duration-weighted means of the linked embeddings. After the last window, speakers never heard in the same window merge
while their centroids' similarity is ≥ 0.7, and past 32 speakers the one with the least speech joins its most similar
speaker. Each window keeps only its segments up to the middle of each overlap, so overlapped speech is attributed once.
The segments become speaker turns: every 100 ms frame of speech gets one speaker (the current speaker keeps overlapped
speech); runs of one speaker < 1 s apart merge; turns < 0.4 s fold into the nearer neighbour < 1 s away; turns are
padded ≤ 0.25 s into silence, never into a neighbour; turns > 30 s split at their quietest frame. Selected VAD coverage
is added without replacing known attribution or duplicating audio (unknown/sliver rules above). Each final turn is
one Tinfoil request through the same arbiter. If final coverage still exceeds the floor bound, the job fails
`processing_failed` before any provider call. A diarizer that fails (or is no longer installed
when the job is claimed) fails the job `processing_failed` before any provider call; the stage is enabled with
`BATCH_DIARIZATION_ENABLED=true` and offered only when its install under `BATCH_DIARIZATION_DIR` is complete.

**Exactly-once dispatch.** A single-row slot table is the arbiter: in one transaction the worker proves its claim, takes
the slot and commits a `started` attempt; only then is the request sent, with no await in between. At most one provider
request is in flight at any time. Outcomes:

| Outcome | Action |
|---|---|
| 200 with text | region completed |
| 429 | new attempt after `Retry-After` (default 30 s, max 120 s); 20 consecutive → treated as 402 below (the job waits) |
| provably not sent (connection refused / DNS / TLS verification) | ≤ 5 attempts with backoff → `provider_unavailable` |
| 400 / 413 / 415 / 422 | `transcription_failed` |
| 402 / 401 / 403 | provider refused before processing (billing, quota or key): nothing was done or billed, so the job **waits**: released to `queued` with a durable not-before (`transcription_provider_blocks.next_attempt_at`), backoff 1, 2, 5, 10, 30 min then every 30 min, at most 24 h from the first block, then `provider_unavailable`. `provider_delayed: true` on the job while it waits. No retry counter or claim is consumed. Logs `batch provider blocked` (once per job per distinct HTTP status, logged as `http_status`) and `batch provider recovered` |
| 404 | `provider_unavailable` + alert (wrong URL or model: a deploy fault) |
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
unlinked. A `failed` or `cancelled` job also loses any partial region text in that transaction (`transcript_deleted_at`
is set); only a `completed` job keeps text, until `DELETE` or 24 h after completion; the audio, PCM and temp files are then removed and verified absent (`ENOENT`) before `files_deleted` is
recorded. `DELETE` cancels an active job, deletes transcript content and hides the job in the same transaction, and keeps
a content-free tombstone (ids, tenant ref, sizes, timings, codes). A sweeper (every 60 s) retries pending deletions,
expires unaccepted uploads, times out processing, recovers dead claims, deletes transcripts 24 h after completion,
removes any artifact the ledger does not authorize (alerting if one reappears after verified deletion), and purges
finished rows 7 days after their files were verified deleted. `/health` reports `retention_lag_seconds` (age of the
oldest pending deletion) and is `degraded` past 300 s. Deleted data may remain on storage media until overwritten.

### Errors and correlation
Every response has `X-Correlation-Id` (the caller's, if 1–128 of `[A-Za-z0-9._:-]`, else a new UUID). Every error body is
`{"error":{"type","code","message","correlation_id", …}}`. Request codes: `invalid_request`, `diarization_unavailable`
(400), `unauthorized`, `insufficient_scope`, `idempotency_conflict`, `transcription_not_found`, `active_transcription_exists`,
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
Meeting service: single dstack CVM: api, worker, Vexa services, redis, postgres. TC-758 is a one-way upgrade
(migration 0023 is additive): once retried batches (more than one attempt) or `gap_align`/`gap_fill`
ledger rows exist, earlier code rejects them at publication and fails those meetings, so do not roll
back past it. Batch transcription runs as its own
service (`PTX_ROLE=batch`: api, `src/uploads/worker.ts`, postgres) with its own Tinfoil credential.

## Non-goals (V1)
Summaries, chat/RAG, agents, calendar UI, user accounts, team workspaces, transcript approval/versioning, voice fingerprints, dashboards, realtime WS events (V2: `WS /v1/meetings/{id}/events`), replacing the Vexa UI.

## Definition of done
`curl -X POST /v1/meetings -d '{"meeting_url":"<local jitsi room>"}'` → `{"id":"mtg_…","status":"queued"}`; fake participant speaks; `GET /v1/meetings/{id}` reaches `completed`; `GET …/transcript` returns speakers/segments/text containing the expected phrase; `meeting.completed` webhook delivered and signature-verified. All exercised by an automated E2E test in the repo.

## Meeting duration (TC-2185)

`POST /v1/meetings` accepts optional `max_duration_seconds`: an integer from `1` to `14400`; omission selects `3600`, and JSON `null` selects the four-hour cap for the UI's “No limit” choice. Duration is measured from `created_at`, including admission time. Meeting objects return the effective `max_duration_seconds` and ISO `scheduled_stop_at`. Existing rows retain a null deadline until their duration is explicitly updated. This contract is separate from batch upload duration capabilities. Details: TC-2185

`PATCH /v1/meetings/{id}` accepts exactly one of `{"extend_by_seconds":900}`, `{"extend_by_seconds":1800}` or `{"max_duration_seconds":<integer|null>}` and returns the updated meeting object. Extensions add to the current total duration, capped at `14400`; an explicit duration replaces that total. Updates are project-owned and serialized with expiry. Processing and terminal meetings do not accept duration changes. A replacement deadline already in the past is applied by the worker's next scan. Details: TC-2185

The meeting worker checks persisted deadlines on its existing heartbeat, normally every five seconds, and before queued dispatch. Expiry uses the established stop path: pre-admission meetings are cancelled; admitted meetings leave capture and continue transcript finalization. The client need not remain open or send a stop request. Worker restarts resume the stored deadlines. Details: TC-2185

