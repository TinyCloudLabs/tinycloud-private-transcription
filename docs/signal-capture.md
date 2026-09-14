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

The first slice maps worker states to the normal PTX lifecycle and normalizes every segment to the
single `Unknown` speaker with `attribution: "unknown"`. Signal chat, reactions, camera, screen
share, autonomous speech, and true speaker attribution remain out of scope.

## Two-seat E2E plan

Run two randomized local Signal Desktop profiles against one call link: each seat joins after a
random jitter, plays a distinct short WAV through its PulseAudio source, then leaves in randomized
order. Assert that PTX reaches `completed`, returns both phrases as timestamped segments with
unknown attribution, and never exposes the call fragment in API bodies, webhook bodies, worker
logs, or persisted plaintext. Repeat with a join timeout and an explicit stop to prove seat release.
