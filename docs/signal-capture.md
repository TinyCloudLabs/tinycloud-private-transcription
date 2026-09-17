# Signal capture boundary

Signal is a PTX capture platform, not a Vexa platform. `src/providers/signal/adapter.ts` routes to
three authenticated capture workers. Each worker owns one Signal Desktop CDP session and PulseAudio
monitor source; PTX only starts, polls, leaves, and removes bounded sessions.

The worker API is deliberately small:

- `POST /v1/calls` receives `{meetingId, callUrl, botName, language}` and returns `session_id`.
- `GET /v1/calls/{session_id}` returns a bounded lifecycle state plus timestamped word segments.
- `POST /v1/calls/{session_id}/leave` and `DELETE /v1/calls/{session_id}` release the seat.

Non-loopback control endpoints require a per-seat bearer token, while each unauthenticated CDP stays
inside its own container's loopback namespace. A `signal.link/call/#key=…` fragment is an
admission capability: PTX stores only AES-GCM ciphertext in `meetings.signal_capability`, never
returns it from meeting reads or webhooks, and clears it at terminal capture. The worker receives
the reconstructed URL only at dispatch. Do not add it to capture diagnostics, logs, metadata, or
status payloads.

`bun run signal-capture-worker` provides the local production boundary. It refuses a non-loopback
CDP URL and refuses a non-loopback control bind without a token. It opens the `sgnl://` deep link
through a short-lived native Signal Desktop launcher,
confirms the launcher has exited, then rediscovers Signal's call window and retries only the exact
permission/lobby actions while the observed UI is joining or awaiting admission. It records only
the configured PulseAudio monitor via `parec`, and invokes the local
`SIGNAL_TRANSCRIBER` argv prefix with a temporary WAV filename. The transcriber writes JSON
`RawSegment[]` to stdout; it has no access to the URL capability. The WAV and native launcher are
removed on leave or delete; the persistent linked Desktop remains available for the next call. A
linked Signal Desktop profile, the exact PulseAudio source, and a
healthy local transcriber are environment provisioning requirements; without them `/health` reports
not ready and no live-capture claim may be made.

To run the real-call operator check, attach a linked account to the persistent `signal-profile`
volume, set `SIGNAL_PULSE_SOURCE` to the seat's playback monitor and provide the in-CVM Whisper
endpoint through `SIGNAL_TRANSCRIBER`; then reach the loopback-only noVNC port over SSH and run
`SIGNAL_CALL_URL='https://signal.link/call/#key=…' bun run scripts/signal-smoke.ts`. The script requires
that operator-supplied link for a live backend, does not log it or write it to its evidence, and
uses a non-live placeholder only for replay-contract checks. Do not use replay mode as evidence of
a live call.

On dstack, `signal-capability-provision` generates the AES-256 key once inside the persistent
`signal-runtime` volume (the legacy volume name is retained so upgrades preserve the existing key).
API and queue worker mount it read-only at `/run/signal-capability`, wait for the private file, and
load it only into their process environments. Signal Desktop/capture cannot mount or modify the key.
Each capture worker writes a fixed-code, fragment-free readiness record to its own health volume
every five seconds; only that seat and the read-only API mount the volume. Public PTX `/health`
advertises capacity only when all three records are fresh and ready. It degrades when any seat is
absent, stale, unlinked, missing its exact PulseAudio source, or unable to reach Whisper through the
transcriber's bounded `--check`.

TinyChat needs no Signal-specific route. Its browser client calls
`https://api.tinycloud.chat/api/transcriber/meetings`, whose existing proxy forwards the unchanged
PTX V1 contract.

Coordination exception: no Linear issue was created for this slice because the workspace's free
issue limit rejected creation; do not retry issue creation until capacity is available.

The first slice maps worker states to the normal PTX lifecycle and normalizes every segment to the
single `Unknown` speaker with `attribution: "unknown"`. Signal chat, reactions, camera, screen
share, autonomous speech, and true speaker attribution remain out of scope.

## Three-seat E2E plan

Run three isolated Signal Desktop profiles against three call links: each seat joins after a random
jitter, receives a distinct spoken phrase through its PulseAudio source, then leaves in randomized
order while a fourth request remains queued. Assert that PTX reaches `completed`, returns each phrase as timestamped segments with
unknown attribution, and never exposes the call fragment in API bodies, webhook bodies, worker
logs, or persisted plaintext. Repeat with a join timeout and an explicit stop to prove seat release.
Use three distinct Signal identities for the production proof; multiple linked desktops on one
account are not accepted as evidence of reliable simultaneous-call capacity.
