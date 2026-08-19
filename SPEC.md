# TinyCloud Private Transcription API — V1 Spec

Repo: `TinyCloudLabs/tinycloud-private-transcription`.
Origin: Conclave × TinyCloud integration for the Zcash demo. Public API is **ours**; Vexa is an internal, replaceable meeting-capture implementation.

## Goal
Client sends a meeting URL → bot joins → client tracks state → client receives a speaker-attributed structured transcript.
Consumers: TinyCloud (`listen` app) and Conclave-shaped clients.

## Decisions (2026-08-17)
- Stack: **Bun + TypeScript** (Hono API + worker), Postgres, Redis queue. Vexa runs as a pinned upstream Docker Compose dependency (Apache-2.0, `Vexa-ai/vexa` main). Do not fork Vexa unless Jitsi live-join is broken; if forking is required, raise it before doing so.
- V1 transcript source: Vexa native transcription (WhisperLive, CPU mode — no GPU on dev host). `TranscriptionProvider` interface from day one; `TinfoilTranscriptionProvider` implemented behind it, tested with a recorded fixture + mock. **No live Tinfoil calls** (no key yet). Confidential inference (Tinfoil + dstack) is required for the product but sequenced last.
- Vexa `POST /bots` exposes `recording_enabled`; verify whether it persists audio — if yes, that's the batch path for Tinfoil. If not, the Tinfoil path is a WhisperLive-compatible shim proxying to Tinfoil realtime (`voxtral-mini-4b-realtime`). Document which is viable.
- E2E test: local `docker-jitsi-meet` + Playwright fake participant that joins the room and plays a known TTS/WAV clip; assert transcript contains expected phrases with a speaker label. Public meet.jit.si needs an authenticated moderator → not used for automated tests.
- dstack/Phala: write the dstack app-compose; **attempt** a dev CVM deploy with the authenticated `phala` CLI in a dedicated workspace; never touch unrelated production CVMs. Small spend OK; stop and report on anything larger.
- Auth: static project API keys (`tc_live_…`, hashed in Postgres), seeded via CLI; single project for demo. Leave room for scopes.
- Multi-tenancy: one Vexa user/token owned by the service; our API does project scoping. Don't mirror projects into Vexa.
- Ship order (happy-path-first):
  1. Stock Vexa locally, bot into local Jitsi room, transcript via Vexa's own API.
  2. API + worker + Postgres: `POST /v1/meetings`, `GET /v1/meetings/{id}`, `POST /v1/meetings/{id}/stop`, `GET /v1/meetings/{id}/transcript`, `DELETE /v1/meetings/{id}` (also deletes in Vexa). Own IDs (`mtg_…`), own error taxonomy, platform detection from URL.
  3. `meeting.completed` + `meeting.failed` webhooks (HMAC-SHA256 `X-Webhook-Signature`, retries immediate/1m/5m/30m/2h; webhook failure never fails the meeting), `Idempotency-Key`.
  4. dstack compose + Phala dev CVM attempt.
  5. Tinfoil provider behind interface (fixture-tested).

## API
Auth: `Authorization: Bearer tc_live_xxx`.

`POST /v1/meetings` body: `meeting_url` (required), `bot_name`, `language`, `webhook_url`, `platform` (override), `metadata` (opaque, echoed everywhere). Returns immediately:
```json
{"id":"mtg_01K…","object":"meeting","status":"queued","platform":"jitsi","meeting_url":"…","created_at":"…","metadata":{}}
```
States: `queued → joining → waiting_for_admission → in_progress → processing → completed`; terminal failures `failed`, `cancelled`. `in_progress` only once the bot is actually admitted. Map from Vexa statuses (`requested/joining/awaiting_admission/active/stopping/completed/failed`).

`GET /v1/meetings/{id}` → status, platform, bot{name,joined_at}, transcript{status}, created/started/ended_at, metadata, error{type,code,message} on failure.
`POST /v1/meetings/{id}/stop` → idempotent, returns `{id,status}`.
`GET /v1/meetings/{id}/transcript` → 202 `{meeting_id,status}` until complete; then
```json
{"meeting_id":"…","status":"completed","language":"en","duration_seconds":0,
 "speakers":[{"id":"speaker_0","name":"Alice"}],
 "segments":[{"id":"seg_001","speaker_id":"speaker_0","speaker_name":"Alice","start":0.0,"end":3.2,"text":"…"}],
 "text":"Alice: …","created_at":"…"}
```
`speaker_id` is stable within a meeting only. `DELETE /v1/meetings/{id}` removes our record + transcript and the Vexa meeting.
`GET /health` → `{status:"ok"}` (internally check Postgres, Redis, Vexa, bot capacity; Tinfoil outage must not block recording — retry in `processing`).

Errors: `{"error":{"type":"meeting_join_failed","code":"waiting_room_timeout","message":"…"}}`. Codes: invalid_meeting_url, unsupported_platform, meeting_not_found, meeting_join_failed, waiting_room_timeout, bot_removed, meeting_ended, capture_failed, transcription_failed, provider_timeout, provider_unavailable, internal_error. Never leak Vexa errors raw.

Platform detection: meet.google.com→google_meet, zoom.us→zoom, teams.microsoft.com→microsoft_teams, meet.jit.si / self-hosted Jitsi→jitsi.

Webhook event: `{"id":"evt_…","type":"meeting.completed","created_at":"…","data":{"meeting_id":"…","metadata":{}}}`.

## Persistence (Postgres)
`meetings(id, project_id, meeting_url, platform, status, bot_name, vexa_native_meeting_id, vexa_bot_id, created_at, started_at, ended_at, completed_at, metadata, error_code, error_message, idempotency_key)`
`transcripts(meeting_id, language, duration_seconds, segments_json, created_at)`
`webhook_deliveries(id, meeting_id, event_type, endpoint, attempt, status, response_code, created_at)`
`api_keys(id, project_id, key_hash, scopes, created_at)`

## Deployment
Single dstack CVM: api, worker, vexa services, redis, postgres. Tinfoil external.

## Non-goals (V1)
Summaries, chat/RAG, agents, calendar UI, user accounts, team workspaces, transcript approval/versioning, voice fingerprints, dashboards, realtime WS events (V2: `WS /v1/meetings/{id}/events`), replacing the Vexa UI.

## Definition of done
`curl -X POST /v1/meetings -d '{"meeting_url":"<local jitsi room>"}'` → `{"id":"mtg_…","status":"queued"}`; fake participant speaks; `GET /v1/meetings/{id}` reaches `completed`; `GET …/transcript` returns speakers/segments/text containing the expected phrase; `meeting.completed` webhook delivered and signature-verified. All exercised by an automated E2E test in the repo.
