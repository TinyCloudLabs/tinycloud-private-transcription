# Vexa findings (capture rig, 2026-08-17)

Upstream: `Vexa-ai/vexa` @ `e0b356d6de3f8322db45d3cb9d66282ae108bebf` (main, "v0.12.22" release notes;
`git describe` = v0.12.18-29). Images `vexaai/v012-*:v012`, bot `vexaai/vexa-bot:v012`. Apache-2.0.
Stack under `infra/vexa`, local Jitsi under `infra/jitsi`, gate `scripts/vexa-smoke.ts` (**green, 3/3 runs**).
Raw payloads: `docs/vexa-samples/*.json` (verbatim from the running stack).

## TL;DR for the API/adapter team
* Base URL (this rig): `http://localhost:18066`. Auth: header `X-API-Key: vxa_…` (user token). Admin: `X-Admin-API-Key` on admin-api `:18057`.
* Create: `POST /bots` `{"platform":"jitsi","meeting_url":"https://jitsi.local:8443/<room>","bot_name":"…","language":"en"}` → **201** `MeetingResponse` (`status:"requested"`, integer `id`, `native_meeting_id: "<room>@jitsi.local"`).
* Address everything else by `(platform, native_meeting_id)`: `GET /transcripts/jitsi/<room>@jitsi.local`, `DELETE /bots/jitsi/<room>@jitsi.local`. `@` in the path works unencoded or encoded.
* Status values observed: `requested → joining → active → stopping → completed`; also `failed` (stopped before join: `completion_reason:"stopped"`, `failure_stage:"requested"`). Contract enums below.
* Transcript = `TranscriptionResponse` with `segments[]` of `{start,end,text,language,speaker,completed,segment_id,absolute_start_time,absolute_end_time}`; `speaker` is the Jitsi display name ("Alice"). Segments include **draft rows** (`segment_id: "turn:N:p0"`, and live-poll `completed:false, source:"merged"`) alongside confirmed rows (`turn:N:0`) — dedupe by `turn:N` when building our transcript.
* `recording_enabled:true` (default) **persists audio to MinIO** (`recordings/<user>/<recording_id>/<session>/audio/*.webm` + assembled `master.webm`, opus 48 kHz stereo) and exposes it via `GET /recordings/{id}/media/{media_file_id}/raw?type=audio` (raw bytes). Offline transcription of that file works → **the batch Tinfoil path is viable** (with a caveat below).

## Auth model
* `ADMIN_TOKEN` (compose env; ours `dev-admin-token`) = `X-Admin-API-Key` for `admin-api` (`/admin/users`, `/admin/users/{id}/tokens?scopes=bot,tx`). Also signs the internal MeetingToken.
* Users own meetings; a user token (`vxa_bot_…`, scopes `bot,tx`) is `X-API-Key` at the gateway. The gateway resolves the key → injects `X-User-Id` etc. into meeting-api. `max_concurrent_bots` is per user (default 5 in provision-token). Upstream helper: `deploy/compose/bin/provision-token` (idempotent: resolve-or-create user `self-host@vexa.ai`, mint token).
* Our plan (one service-owned Vexa user, project scoping done in our API) fits: mint one token at bring-up, keep it in our secrets.
* Auth errors: 401 `{"detail":"Missing API key"}` / `{"detail":"Invalid API key"}`.

## POST /bots — request/response
Request (what we send):
```json
{"platform":"jitsi","meeting_url":"https://jitsi.local:8443/ptx-smoke-msxhmw1k","bot_name":"TinyCloud Notetaker","language":"en"}
```
Other accepted fields (api.v1 `MeetingCreate`): `native_meeting_id`, `task` (`transcribe|translate`), `transcription_tier` (`realtime` default | `deferred`), `recording_enabled`, `transcribe_enabled`, `passcode` (Jitsi room password), `automatic_leave{max_bot_time,max_wait_for_admission,max_time_left_alone,no_one_joined_timeout}` (ms), `video`, `voice_agent_enabled`, … `webhook` config is per user (`PUT /user/webhook`), not per bot.

Response **201** (`docs/vexa-samples/vexa-post-bots-response.json`):
```json
{"id":1,"user_id":1,"platform":"jitsi","native_meeting_id":"ptx-smoke-msxhmw1k@jitsi.local",
 "constructed_meeting_url":"https://jitsi.local:8443/ptx-smoke-msxhmw1k","status":"requested",
 "bot_container_id":"mtg-1-02a27ddc","start_time":null,"end_time":null,"completion_reason":null,"failure_stage":null,
 "data":{"recording_enabled":true,"transcribe_enabled":true,"constructed_meeting_url":"https://jitsi.local:8443/ptx-smoke-msxhmw1k","sessions":["02a27ddc-…"]},
 "created_at":"2026-08-17T17:08:43.862932Z","updated_at":"2026-08-17T17:08:44.361744Z"}
```
Validation (all **422** `{"detail": "..."}` strings, no error codes):
* `meeting_url must use https:// — the bot only joins TLS deployments`
* `meeting_url cannot be an IP literal — use the deployment's hostname` · `meeting_url cannot target localhost`
* `unsupported platform 'jitsi' without a meeting_url — use google_meet/teams, or provide meeting_url (required for zoom/jitsi)` (jitsi/zoom REQUIRE `meeting_url`; `native_meeting_id` alone is not enough)
* unrecognised URL: `'native_meeting_id' is required: it could not be derived from meeting_url '…' (unrecognized meeting link)`
* **409** duplicate: `An active meeting already exists for jitsi/<id>` (per user, per (platform,native_id) while non-terminal)
* **503** when STT is not configured (`TranscriptionNotConfigured`) unless `transcribe_enabled:false`.
* Jitsi URL parsing (`collector/meeting_link.py`): host `meet.jit.si` → bare room; any other host containing `jitsi` or a `meet.` label, or listed in `VEXA_JITSI_HOSTS` → `native_meeting_id = "<room>@<host>"`. Room = the URL path segment, kept verbatim. Note the *host* is embedded, not the port.

## Status polling
`GET /bots/status` → `{"running":[MeetingResponse…],"running_bots":[…same…],"count":n}` — only non-terminal rows (`requested·joining·awaiting_admission·active·stopping`); a finished meeting simply disappears from it (poll `GET /meetings` or `GET /meetings/{id}` for terminal state). Timeline of run 1 (see `vexa-bots-status-snapshots.json`): requested @0s → joining @+3s → active @+8s (Alice already in the room, no lobby) → first transcript segment @+30s → stopping on DELETE → completed +6s later. `data.status_transition[]` in the meeting row records `{from,to,source:"bot_callback"|"runtime_destroy",timestamp,completion_reason?}`.

lifecycle.v1 enums: `BotStatus` `joining|awaiting_admission|active|needs_help|completed|failed` (plus `requested`/`stopping` on the API side); `CompletionReason` `stopped|left_alone|startup_alone|evicted|awaiting_admission_timeout|awaiting_admission_rejected|join_failure|auth_session_missing|validation_error|max_bot_time_exceeded`; `FailureStage` `requested|joining|awaiting_admission|active`. Mapping to our spec states: requested→queued, joining→joining, awaiting_admission→waiting_for_admission, active→in_progress, stopping→processing, completed→completed, failed→failed (with completion_reason → our error code: awaiting_admission_timeout→waiting_room_timeout, evicted→bot_removed, join_failure→meeting_join_failed, …).

## Transcript JSON (GET /transcripts/{platform}/{native_meeting_id})
`docs/vexa-samples/vexa-transcript.json` (full). Shape:
```json
{"id":1,"platform":"jitsi","native_meeting_id":"…@jitsi.local","constructed_meeting_url":"https://…","status":"completed",
 "start_time":"2026-08-17T17:08:51.852399Z","end_time":"2026-08-17T17:09:35.481743Z",
 "recordings":[{"id":440464823505,"source":"bot","status":"completed","meeting_id":1,"session_uid":"…",
    "media_files":[{"id":433432982412,"type":"audio","format":"webm","is_final":true,"chunk_count":3,"file_size_bytes":7192,
                    "storage_backend":"minio","storage_path":"recordings/1/440464823505/<session>/audio/000001.webm","metadata":{"sample_rate":16000},"duration_seconds":null}],
    "playback_url":{"audio":"/recordings/440464823505/master?type=audio","video":null},"completed_at":"…"}],
 "notes":null,
 "data":{"recordings":[…same…],"stop_requested":true,"completion_reason":"stopped","recording_enabled":true,"transcribe_enabled":true,
         "segments_captured":0,"status_transition":[…],"constructed_meeting_url":"…"},
 "segments":[
   {"start":1786986557.63,"end":1786986562.20,"text":"The quick brown fox jumps over the lazy dog.","language":"en","speaker":"Alice",
    "completed":true,"segment_id":"turn:6:0","absolute_start_time":"2026-08-17T17:09:17.634485Z","absolute_end_time":"2026-08-17T17:09:22.207508Z"}
 ]}
```
Notes: `start`/`end` are **epoch seconds** (floats), not meeting-relative — compute offsets from `start_time`; `absolute_*` are ISO. While live, segments carry `"source":"merged"` and drafts have `completed:false`; after completion the field is gone and drafts flip to `completed:true` (dedupe on the `turn:N` prefix, prefer `turn:N:0`). `data.segments_captured` was `0` despite 7 segments (ignore). 404 `{"detail":"Meeting not found for platform jitsi and ID …"}` until the row exists (it exists immediately after POST, with `segments: []`).

## DELETE /bots/{platform}/{native_meeting_id}
200 `{"status":"stopping","meeting_id":1,"native_meeting_id":"…"}`; second call 404 `{"detail":"No active meeting for this bot"}`. The bot leaves gracefully (`APP.conference.hangup()`), flushes the final recording chunk, and the row goes `stopping → completed` (~6 s). Also `DELETE /meetings/{platform}/{native}` and `DELETE /meetings/{meeting_id}` (204) exist to remove records.

## `recording_enabled` — does audio persist, where?
**Yes.** Default true (`RECORDING_ENABLED` env / per-request). The bot's page-side `createRecordingTap` mixes every `<audio>/<video>` element into one MediaRecorder (`audio/webm;codecs=opus`, 15 s timeslices, `VEXA_RECORDING_TIMESLICE_MS`), uploads chunks to meeting-api `/internal/recordings/upload`, which stores them in **MinIO** bucket `vexa` and assembles `master.webm` at finalization. Read back with the user key:
`GET /recordings` (list) → `GET /recordings/{id}/master?type=audio` → `{"storage_path":".../master.webm","media_file_id":…,"raw_url":"/recordings/{id}/media/{media_file_id}/raw?type=audio","duration_seconds":null}` → `GET …/raw?type=audio` = `audio/webm` bytes.
Verified: run 2 (12.6 s) and run 3 (22.8 s) recordings, decoded with ffmpeg and posted to whisper offline, transcribe to "The quick brown fox jumps over the lazy dog. Below from Alice." — the recording is the meeting mix, usable as the batch input to Tinfoil (`voxtral-mini-4b`) → **batch path viable**. Caveat: run 1's recording (37.9 s, 4 chunks, 9 KB) was **silence** although the live transcript was fine — the tap grabs media elements once at start (5×2 s retries), so it can latch onto a stale/silent element on the very first meeting after a cold stack; treat recording content as needing a sanity check (size/bitrate) before relying on it, and keep WhisperLive-shim as fallback. There is also `POST /meetings/{meeting_id}/transcribe` ("Transcribe a completed meeting recording", forwarded to meeting-api) — not exercised.

## Resource footprint per bot (this host: 64 vCPU, no GPU)
* Bot container `ptx/vexa-bot:v012-devca` (image 1.62 GB, `shm=2g`, no cpu/mem limits set by runtime): Chromium launch burst ~10 cores for a few seconds, then ~10–15 % of one core steady, **~470 MB RSS** for a 2-party call. Xvfb+PulseAudio+headful Chromium.
* `whisper` (faster-whisper-server, small.en, int8, CPU): 1.4 GB RSS idle; bursts to ~10 cores while decoding a segment (default `CPU_THREADS` = all). One instance is shared by all bots. Upstream note: `small` keeps real-time on 4–6 vCPU; `medium` sheds load on CPU.
* Control plane (postgres, valkey, minio, admin-api, runtime, meeting-api, gateway, agent-api, mcp, terminal): ~1 GB total, negligible CPU idle.
* Bot lifetime for a 60 s meeting ≈ 75 s (join ~8 s, leave+flush ~6 s).

## Jitsi quirks / what made the live join work
* Upstream marks Jitsi "offline-proven; live validation pending" — it **worked first try** against docker-jitsi-meet `stable-11146-2` with the default prejoin page: the bot navigates to `<url>#config.startWithAudioMuted=true&config.startWithVideoMuted=true&userInfo.displayName="<bot_name>"`, types the name into `#premeeting-name-input`, clicks `[data-testid="prejoin.joinMeeting"]`, then checks `APP.conference.isJoined()`; no lobby → `active` in ~5 s. Speaker attribution comes from Jitsi's dominant-speaker events (`[JitsiSpeakers] dominant speaker → Alice`), audio from mirroring remote WebRTC tracks (`[mixed] capture started over 2 stream(s)`).
* Non-negotiables: `https://` + hostname (not IP/localhost) in `meeting_url`; the bot's Chromium must **trust** the cert (no ignore-errors flag) → derived bot image with our CA (`infra/vexa/bot`). No Vexa fork or env knob needed; there is no upstream knob to relax the URL check.
* Bot ↔ Jitsi network: bots run on the compose network `vexa-v012_vexa`; Jitsi `web` + `jvb` join it with alias `jitsi.local`. `PUBLIC_URL=https://jitsi.local:8443` (the web container listens on 8443 internally, so the same URL works from the host and in-network). JVB UDP 10000 published; `JVB_ADVERTISE_IPS=172.17.0.1` + private candidates on for host-side clients.
* Jitsi env for anonymous rooms: `ENABLE_AUTH=0 ENABLE_GUESTS=1 ENABLE_LOBBY=0 ENABLE_LETSENCRYPT=0 ENABLE_XMPP_WEBSOCKET=1 ENABLE_P2P=0`. docker-jitsi-meet needs the component passwords set and the bind-mounted `cfg/` dirs writable by uid 1000 (`compose.sh` does the mkdir/chmod).
* Jitsi's client logs harmless `Strophe error: service-unavailable` (no TURN service) — ignore.
* Empty-room behaviour: bot `aloneness` window is 600 s by default (`automatic_leave.max_time_left_alone`); with Alice present it never triggered. Bot joins muted; it never speaks.
* `native_meeting_id` for self-hosted Jitsi is `room@host` — keep our meetings table's `vexa_native_meeting_id` as an opaque string.

## Fake participant / STT notes
* Chromium fake mic: `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --use-file-for-fake-audio-capture=<48 kHz mono s16 WAV>`; Chromium loops the file. Jitsi force-mutes on join in some configs → the script calls `APP.conference.muteAudio(false)` until unmuted. `channel:"chromium"` (new headless) is needed for WebRTC + fake devices; `--ignore-certificate-errors` on the host side only.
* Fixture: espeak-ng `en-us+f2 -s 130 -p 55` (11 s incl. lead/tail silence). Whisper small.en transcribes it verbatim offline; live via the bot the phrase came through as "The quick brown fox jumps over the lazy dog." (draft rows occasionally mishear "fox" — assert on the confirmed `turn:N:0` rows).
