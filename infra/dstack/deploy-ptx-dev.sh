#!/usr/bin/env bash
# Update the existing ptx-dev CVM from infra/dstack/app-compose.yaml and, unless --keep-sealed-env, the operator's
# sealed env file.
#
#   npm ci --ignore-scripts --no-audit --no-fund --prefix .github/scripts   # pinned phala CLI + SDK, once
#   PHALA_CLOUD_API_KEY=... infra/dstack/deploy-ptx-dev.sh [env-file]          # default infra/dstack/.env
#   PHALA_CLOUD_API_KEY=... infra/dstack/deploy-ptx-dev.sh --keep-sealed-env   # compose only
#
# --keep-sealed-env sends the compose file without `-e`: phala 1.1.22's update request then carries neither
# encrypted_env nor allowed_envs, so the CVM keeps its sealed variables and allowed_envs as they are, and the
# allowed_envs sync is skipped. The compose check renders with no env file, so only compose defaults apply. Use
# it for a compose-only change when nobody holds the env file; a change that needs a new or different sealed
# value needs the env file.
#
# Before any change it refuses an api image whose migrations include a destructive one ptx-dev has not run (TC-3490;
# scripts/migration-gate.ts), unless DESTRUCTIVE_MIGRATION_ACK names exactly those migrations, comma-separated. That
# ack needs its own GO: ptx-dev holds user recordings and transcripts. The live commit must be in this checkout.
#
# Fails closed, before any change, unless the CVM runs the pinned production OS image. The same check runs
# again, against the resolved CVM id, right after `phala deploy` and after the allowed_envs sync (even if
# either failed); any failure exits non-zero. The Phala KMS only releases the app keys to that image. This
# script never changes the OS: `phala deploy --image/--no-dev-os` is ignored for an existing CVM. To set it
# by hand:
#   phala api -X PATCH /cvms/<id>/os-image -F os_image_name=dstack-0.5.15
#
# phala 1.1.22's update request (`deploy --cvm-id`) already sends allowed_envs set to the env-file keys, so
# the allowed_envs sync that follows (the one deploy-batch.yml runs) is normally a no-op. It stays as a check:
# dstack drops sealed variables that are not on that list, and the sync fails if a key is still missing.
set -euo pipefail

CVM_NAME=ptx-dev
PHALA_OS_IMAGE=dstack-0.5.15
PHALA_OS_IMAGE_HASH=4597735f1a38ad8ec9f781356b88737fc052062deb7c9aaa4be89bf1b35643ca

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
COMPOSE=infra/dstack/app-compose.yaml
if [ "${1:-}" = --keep-sealed-env ]; then
  KEEP_SEALED_ENV=true
  ENV_FILE=/dev/null
else
  KEEP_SEALED_ENV=false
  ENV_FILE="${1:-infra/dstack/.env}"
fi
PHALA="${PHALA:-$PWD/.github/scripts/node_modules/.bin/phala}"

fail() { echo "deploy-ptx-dev: $*" >&2; exit 1; }
[ -n "${PHALA_CLOUD_API_KEY:-}" ] || fail "PHALA_CLOUD_API_KEY is not set"
[ "$KEEP_SEALED_ENV" = true ] || [ -f "$ENV_FILE" ] || fail "env file $ENV_FILE not found"
[ -x "$PHALA" ] || fail "phala CLI not found at $PHALA; run: npm ci --ignore-scripts --no-audit --no-fund --prefix .github/scripts"

# require_production_os <name or id> <when>: sets CVM_ID from the checked CVM.
require_production_os() {
  local cvm os id
  cvm="$("$PHALA" cvms get "$1" --json)" || fail "could not read CVM $1 $2"
  os="$(jq -c '.os' <<<"$cvm")"
  jq -e --arg name "$PHALA_OS_IMAGE" --arg hash "$PHALA_OS_IMAGE_HASH" \
    '.is_dev == false and .name == $name and .os_image_hash == $hash' <<<"$os" >/dev/null \
    || fail "$1 is not on the production OS image $PHALA_OS_IMAGE ($PHALA_OS_IMAGE_HASH) $2. Found: $os"
  id="$(jq -r '.id // empty' <<<"$cvm")"
  [ -n "$id" ] || fail "could not resolve the id of $1 $2"
  [ -z "${CVM_ID:-}" ] || [ "$id" = "$CVM_ID" ] || fail "$1 resolved to $id, expected $CVM_ID $2"
  CVM_ID="$id"
}

CVM_ID=
require_production_os "$CVM_NAME" "before deploy"
docker compose -f "$COMPOSE" --env-file "$ENV_FILE" config --quiet

IMAGE_REPO=ghcr.io/tinycloudlabs/tinycloud-private-transcription/api
pinned="$(grep -E "^ +image: ${IMAGE_REPO}:[0-9a-f]{40}@sha256:[0-9a-f]{64}$" "$COMPOSE" | sed -E 's/.*:([0-9a-f]{40})@.*/\1/' | sort -u)"
[[ "$pinned" =~ ^[0-9a-f]{40}$ ]] || fail "$COMPOSE must pin every $IMAGE_REPO image to one commit and digest"
live="$(PHALA_CVM_ID="$CVM_ID" IMAGE_REPO="$IMAGE_REPO" node .github/scripts/phala-live-image.mjs)" \
  || fail "could not read the live api image of $CVM_NAME"
env -u PHALA_CLOUD_API_KEY bun scripts/migration-gate.ts deploy "$live" "$pinned" "${DESTRUCTIVE_MIGRATION_ACK:-}" \
  || fail "destructive-migration gate refused the deploy (TC-3490); nothing was changed"

env_args=(-e "$ENV_FILE")
[ "$KEEP_SEALED_ENV" = false ] || env_args=()
rc=0
"$PHALA" deploy --cvm-id "$CVM_ID" -c "$COMPOSE" "${env_args[@]}" \
  --no-public-logs --no-public-sysinfo --no-dev-os --image "$PHALA_OS_IMAGE" --wait || rc=$?
require_production_os "$CVM_ID" "after phala deploy"
[ "$rc" -eq 0 ] || fail "phala deploy exited $rc"

if [ "$KEEP_SEALED_ENV" = false ]; then
  PHALA_CVM_ID="$CVM_ID" ENV_FILE="$ENV_FILE" node .github/scripts/phala-sync-allowed-envs.mjs || rc=$?
  require_production_os "$CVM_ID" "after the allowed_envs sync"
  [ "$rc" -eq 0 ] || fail "allowed_envs sync exited $rc"
fi

echo "deploy-ptx-dev: $CVM_NAME ($CVM_ID) updated on $PHALA_OS_IMAGE$([ "$KEEP_SEALED_ENV" = false ] || echo ", sealed env kept")"
