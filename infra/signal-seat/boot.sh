#!/bin/sh
set -eu

export DISPLAY="${DISPLAY:-:$(expr $$ % 8000 + 100)}"
# Docker restart retains /tmp. A new private runtime directory prevents stale PulseAudio sockets
# and X11 state from keeping an otherwise persistent, linked profile in a restart loop.
export XDG_RUNTIME_DIR="$(mktemp -d /tmp/ptx-signal-runtime.XXXXXX)"
mkdir -p "$SIGNAL_PROFILE_DIR"
chmod 700 "$XDG_RUNTIME_DIR" "$SIGNAL_PROFILE_DIR"
# DISPLAY is deterministic across ordinary container restarts.  These are only stale Xvfb runtime
# markers (not profile data); remove them before starting a replacement server on that display.
DISPLAY_NUMBER="${DISPLAY#:}"
VNC_PORT="${SIGNAL_VNC_PORT:-5900}"
NOVNC_PORT="${SIGNAL_NOVNC_PORT:-6080}"
CDP_PORT="${SIGNAL_CDP_PORT:-9222}"
rm -f "/tmp/.X${DISPLAY_NUMBER}-lock" "/tmp/.X11-unix/X${DISPLAY_NUMBER}"
# These are Chromium runtime locks, not Signal profile data.  A container crash can leave them
# behind and prevent the persistent linked profile from starting after an ordinary restart.
rm -f "$SIGNAL_PROFILE_DIR/SingletonCookie" "$SIGNAL_PROFILE_DIR/SingletonLock" "$SIGNAL_PROFILE_DIR/SingletonSocket"

pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=ptx_sink >/dev/null 2>&1 || true
# Signal's playback is the transcription input; make this the process-wide default before
# Desktop starts. Its microphone must be a separate silent sink: never route the captured
# playback monitor back into the call.
pactl set-default-sink ptx_sink
pactl load-module module-null-sink sink_name=ptx_input_sink >/dev/null 2>&1 || true
pactl load-module module-remap-source master=ptx_input_sink.monitor source_name=ptx_input >/dev/null 2>&1 || true
pactl set-default-source ptx_input
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp &
x11vnc -display "$DISPLAY" -localhost -forever -shared -nopw -rfbport "$VNC_PORT" &
websockify --web /usr/share/novnc "$NOVNC_PORT" "localhost:$VNC_PORT" &

# Signal must already be linked in the persistent profile. No account provisioning occurs here.
# RingRTC opens PulseAudio natively, while video device enumeration happens in Electron. Provide a
# synthetic camera so a video-capable call link can render its lobby on a headless CVM; the worker
# explicitly turns that camera off before joining. Auto-granting media permissions also prevents a
# first-call Electron permission modal from blocking an unattended seat.
signal-desktop --no-sandbox --user-data-dir="$SIGNAL_PROFILE_DIR" \
  --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port="$CDP_PORT" &
exec bun run src/providers/signal/worker.ts
