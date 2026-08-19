#!/usr/bin/env bash
# Wrapper: `infra/jitsi/compose.sh <docker compose args>` runs local docker-jitsi-meet with our env + overlay.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
# docker-jitsi-meet containers run as uid 1000 and need writable bind-mounted config/storage dirs.
for d in web prosody/config prosody/prosody-plugins-custom jicofo jvb storage/web storage/prosody storage/transcripts tmp/web-load-test; do
  mkdir -p "cfg/$d"; done
chmod -R a+rwX cfg 2>/dev/null || sudo chmod -R a+rwX cfg
exec sudo docker compose -p ptx-jitsi --env-file "$HERE/jitsi.env" -f docker-compose.yml -f docker-compose.override.yml "$@"
