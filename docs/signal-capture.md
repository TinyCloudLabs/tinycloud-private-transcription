# Signal capture boundary

Signal is a PTX capture platform, not a Vexa platform. `src/providers/signal/adapter.ts` speaks
only to a loopback capture worker. That worker owns the Signal Desktop CDP session and its
PulseAudio monitor source; PTX only starts, polls, leaves, and removes bounded sessions.

The worker API is deliberately small:

- `POST /v1/calls` receives `{meetingId, callUrl, botName, language}` and returns `session_id`.
- `GET /v1/calls/{session_id}` returns a bounded lifecycle state plus timestamped word segments.
- `POST /v1/calls/{session_id}/leave` and `DELETE /v1/calls/{session_id}` release the seat.

The service rejects a non-loopback `SIGNAL_CAPTURE_URL`. A `signal.link/call/#…` fragment is an
admission capability: PTX stores only AES-GCM ciphertext in `meetings.signal_capability`, never
returns it from meeting reads or webhooks, and clears it at terminal capture. The worker receives
the reconstructed URL only at dispatch. Do not add it to capture diagnostics, logs, metadata, or
status payloads.

`bun run signal-capture-worker` provides the local production boundary. It refuses a non-loopback
CDP URL/bind, opens the Signal URL in an ephemeral CDP target, then rediscovers Signal's call window
and retries only the exact permission/lobby actions while the observed UI is joining or awaiting
admission. It records only the configured PulseAudio monitor via `parec`, and invokes the local
`SIGNAL_TRANSCRIBER` argv prefix with a temporary WAV filename. The transcriber writes JSON
`RawSegment[]` to stdout; it has no access to the URL capability. The WAV and ephemeral CDP target
are removed on leave or delete. A linked Signal Desktop profile, a PulseAudio source, and a local
transcriber are environment provisioning requirements; without them `/health` reports not ready and
no live-capture claim may be made.

To run the real-call operator check, attach a linked account to the persistent `signal-profile`
volume, set `SIGNAL_PULSE_SOURCE` to the seat's playback monitor and provide the in-CVM Whisper
endpoint through `SIGNAL_TRANSCRIBER`; then reach the loopback-only noVNC port over SSH and run
`SIGNAL_CALL_URL='https://signal.link/call/#…' bun run scripts/signal-smoke.ts`. The script requires
that operator-supplied link for a live backend, does not log it or write it to its evidence, and
uses a non-live placeholder only for replay-contract checks. Do not use replay mode as evidence of
a live call.

On dstack, `signal-capability-provision` generates the AES-256 key once inside the persistent
`signal-runtime` volume. API and queue worker wait for that private file and load it only into their
process environments; it is neither an operator-supplied deployment secret nor a public health
field. The capture worker writes a fragment-free readiness record to the same private volume every
five seconds. Public PTX `/health` degrades when that record is absent, stale, unlinked, or not
ready, instead of treating core database health as Signal readiness.

Coordination exception: no Linear issue was created for this slice because the workspace's free
issue limit rejected creation; do not retry issue creation until capacity is available.

The first slice maps worker states to the normal PTX lifecycle and normalizes every segment to the
single `Unknown` speaker with `attribution: "unknown"`. Signal chat, reactions, camera, screen
share, autonomous speech, and true speaker attribution remain out of scope.

## Two-seat E2E plan

Run two randomized local Signal Desktop profiles against one call link: each seat joins after a
random jitter, plays a distinct short WAV through its PulseAudio source, then leaves in randomized
order. Assert that PTX reaches `completed`, returns both phrases as timestamped segments with
unknown attribution, and never exposes the call fragment in API bodies, webhook bodies, worker
logs, or persisted plaintext. Repeat with a join timeout and an explicit stop to prove seat release.
