#!/bin/sh
set -eu

export DISPLAY="${DISPLAY:-:99}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg}"
mkdir -p "$XDG_RUNTIME_DIR" "$SIGNAL_PROFILE_DIR"
chmod 700 "$XDG_RUNTIME_DIR" "$SIGNAL_PROFILE_DIR"

pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=ptx_sink >/dev/null 2>&1 || true
# Signal's playback is the transcription input; make this the process-wide default before
# Desktop starts. The remapped source also gives Desktop a deterministic silent input device.
pactl set-default-sink ptx_sink
pactl load-module module-remap-source master=ptx_sink.monitor source_name=ptx_input >/dev/null 2>&1 || true
pactl set-default-source ptx_input
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp &
x11vnc -display "$DISPLAY" -localhost -forever -shared -nopw -rfbport 5900 &
websockify --web /usr/share/novnc 6080 localhost:5900 &

# Signal must already be linked in the persistent profile.  No account provisioning occurs here.
signal-desktop --no-sandbox --user-data-dir="$SIGNAL_PROFILE_DIR" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 &
exec bun run src/providers/signal/worker.ts
