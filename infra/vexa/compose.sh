#!/usr/bin/env bash
# Wrapper: `infra/vexa/compose.sh <docker compose args>` runs the pinned upstream Vexa compose stack
# with our env + overlay. Example: infra/vexa/compose.sh up -d --no-build
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
exec sudo docker compose -p vexa-v012 --env-file "$HERE/vexa.env" \
  -f "$HERE/upstream/deploy/compose/docker-compose.yml" \
  -f "$HERE/docker-compose.override.yml" "$@"
