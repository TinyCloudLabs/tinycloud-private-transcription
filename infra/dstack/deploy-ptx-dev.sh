#!/usr/bin/env bash
# Update the existing ptx-dev CVM from infra/dstack/app-compose.yaml and the operator's sealed env file.
#
#   npm ci --ignore-scripts --no-audit --no-fund --prefix .github/scripts   # pinned phala CLI + SDK, once
#   PHALA_CLOUD_API_KEY=... infra/dstack/deploy-ptx-dev.sh [env-file]          # default infra/dstack/.env
#
# Fails closed, before any change, unless the CVM runs the pinned production OS image. The same check runs
# again, against the resolved CVM id, right after `phala deploy` and after the allowed_envs sync (even if
# either failed); any failure exits non-zero. The Phala KMS only releases the app keys to that image. This
# script never changes the OS: `phala deploy --image/--no-dev-os` is ignored for an existing CVM. To set it
# by hand:
#   phala api -X PATCH /cvms/<id>/os-image -F os_image_name=dstack-0.5.12
#
# phala 1.1.22's update request (`deploy --cvm-id`) already sends allowed_envs set to the env-file keys, so
# the allowed_envs sync that follows (the one deploy-batch.yml runs) is normally a no-op. It stays as a check:
# dstack drops sealed variables that are not on that list, and the sync fails if a key is still missing.
set -euo pipefail

CVM_NAME=ptx-dev
PHALA_OS_IMAGE=dstack-0.5.12
PHALA_OS_IMAGE_HASH=8db40cb23008d6213668b5816702d100b37b859a8a5bfd18d938ae3a1b3715bd

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
COMPOSE=infra/dstack/app-compose.yaml
ENV_FILE="${1:-infra/dstack/.env}"
PHALA="${PHALA:-$PWD/.github/scripts/node_modules/.bin/phala}"

fail() { echo "deploy-ptx-dev: $*" >&2; exit 1; }
[ -n "${PHALA_CLOUD_API_KEY:-}" ] || fail "PHALA_CLOUD_API_KEY is not set"
[ -f "$ENV_FILE" ] || fail "env file $ENV_FILE not found"
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

rc=0
"$PHALA" deploy --cvm-id "$CVM_ID" -c "$COMPOSE" -e "$ENV_FILE" \
  --no-public-logs --no-public-sysinfo --no-dev-os --image "$PHALA_OS_IMAGE" --wait || rc=$?
require_production_os "$CVM_ID" "after phala deploy"
[ "$rc" -eq 0 ] || fail "phala deploy exited $rc"

PHALA_CVM_ID="$CVM_ID" ENV_FILE="$ENV_FILE" node .github/scripts/phala-sync-allowed-envs.mjs || rc=$?
require_production_os "$CVM_ID" "after the allowed_envs sync"
[ "$rc" -eq 0 ] || fail "allowed_envs sync exited $rc"

echo "deploy-ptx-dev: $CVM_NAME ($CVM_ID) updated on $PHALA_OS_IMAGE"
