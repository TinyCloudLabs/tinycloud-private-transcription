#!/usr/bin/env bash
# Generates fixtures/<name>.wav deterministically (espeak-ng inside a container; no host TTS needed).
#   scripts/make-fixture.sh          # alice (default): "The quick brown fox…", female voice
#   scripts/make-fixture.sh bob      # bob: second speaker (male voice) for multi-turn tests
# Output: 48 kHz mono 16-bit PCM WAV, ~12 s (lead-in silence, phrase, tail) — Chromium's
# --use-file-for-fake-audio-capture loops it, so the phrase repeats for the whole session.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="${1:-alice}"
case "$NAME" in
  alice) PHRASE="The quick brown fox jumps over the lazy dog. Hello from Alice."; VOICE="en-us+f2"; PITCH=55 ;;
  bob)   PHRASE="Good morning everyone, this is Bob. The meeting starts now."; VOICE="en-us+m3"; PITCH=35 ;;
  *) echo "unknown fixture: $NAME (alice|bob)" >&2; exit 2 ;;
esac
mkdir -p "$ROOT/fixtures"
sudo docker run --rm -v "$ROOT/fixtures:/out" debian:stable-slim bash -c '
  set -e
  apt-get update -qq >/dev/null && apt-get install -y -qq espeak-ng ffmpeg >/dev/null
  espeak-ng -v '"$VOICE"' -s 130 -p '"$PITCH"' -a 180 -g 6 "'"$PHRASE"'" -w /tmp/raw.wav
  # 1.5 s lead-in silence + phrase + 2.5 s tail, then 48k mono s16le. Silence lets VAD/segmenters settle.
  ffmpeg -y -loglevel error -f lavfi -t 1.5 -i anullsrc=r=48000:cl=mono -i /tmp/raw.wav -f lavfi -t 2.5 -i anullsrc=r=48000:cl=mono \
    -filter_complex "[1:a]aresample=48000,aformat=channel_layouts=mono[v];[0:a][v][2:a]concat=n=3:v=0:a=1[a]" -map "[a]" \
    -ar 48000 -ac 1 -c:a pcm_s16le /out/'"$NAME"'.wav
  chown '"$(id -u):$(id -g)"' /out/'"$NAME"'.wav
'
ls -la "$ROOT/fixtures/$NAME.wav"
