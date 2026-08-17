#!/usr/bin/env bash
# Generates fixtures/alice.wav deterministically (espeak-ng inside a container; no host TTS needed).
# Output: 48 kHz mono 16-bit PCM WAV, ~12 s (phrase, pause, phrase) — Chromium's
# --use-file-for-fake-audio-capture loops it, so the phrase repeats for the whole session.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PHRASE="The quick brown fox jumps over the lazy dog. Hello from Alice."
mkdir -p "$ROOT/fixtures"
sudo docker run --rm -v "$ROOT/fixtures:/out" debian:stable-slim bash -c '
  set -e
  apt-get update -qq >/dev/null && apt-get install -y -qq espeak-ng ffmpeg >/dev/null
  espeak-ng -v en-us+f3 -s 140 -p 50 -a 180 "'"$PHRASE"'" -w /tmp/raw.wav
  # 1.5 s lead-in silence + phrase + 2.5 s tail, then 48k mono s16le. Silence lets VAD/segmenters settle.
  ffmpeg -y -loglevel error -f lavfi -t 1.5 -i anullsrc=r=48000:cl=mono -i /tmp/raw.wav -f lavfi -t 2.5 -i anullsrc=r=48000:cl=mono \
    -filter_complex "[1:a]aresample=48000,aformat=channel_layouts=mono[v];[0:a][v][2:a]concat=n=3:v=0:a=1[a]" -map "[a]" \
    -ar 48000 -ac 1 -c:a pcm_s16le /out/alice.wav
  chown '"$(id -u):$(id -g)"' /out/alice.wav
'
ls -la "$ROOT/fixtures/alice.wav"
