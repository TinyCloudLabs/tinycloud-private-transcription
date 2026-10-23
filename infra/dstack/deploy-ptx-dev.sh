#!/usr/bin/env bash
# Update the existing ptx-dev CVM from infra/dstack/app-compose.yaml and the operator's sealed env file.
#
#   npm ci --ignore-scripts --no-audit --no-fund --prefix .github/scripts   # pinned phala CLI + SDK, once
#   PHALA_CLOUD_API_KEY=... infra/dstack/deploy-ptx-dev.sh [env-file]          # default infra/dstack/.env
#
# Fails closed, before any change, unless the CVM runs the pinned production OS image, and again after the
# deploy if it does not. The Phala KMS only releases the app keys to that image. This script never changes
# the OS: `phala deploy --image/--no-dev-os` is ignored for an existing CVM. To set it by hand:
#   phala api -X PATCH /cvms/<id>/os-image -F os_image_name=dstack-0.5.12
#
# `phala deploy` does not update the CVM's allowed_envs whitelist, and dstack drops sealed variables that are
# not on it, so the deploy is followed by the same allowed_envs sync deploy-batch.yml runs.
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

require_production_os() {
  local cvm os
  cvm="$("$PHALA" cvms get "$CVM_NAME" --json)" || fail "could not read CVM $CVM_NAME"
  os="$(jq -c '.os' <<<"$cvm")"
  jq -e --arg name "$PHALA_OS_IMAGE" --arg hash "$PHALA_OS_IMAGE_HASH" \
    '.is_dev == false and .name == $name and .os_image_hash == $hash' <<<"$os" >/dev/null \
    || fail "$CVM_NAME is not on the production OS image $PHALA_OS_IMAGE ($PHALA_OS_IMAGE_HASH) $1. Found: $os"
  CVM_ID="$(jq -r '.id // empty' <<<"$cvm")"
  [ -n "$CVM_ID" ] || fail "could not resolve the id of $CVM_NAME"
}

require_production_os "before deploy"
docker compose -f "$COMPOSE" --env-file "$ENV_FILE" config --quiet

"$PHALA" deploy --cvm-id "$CVM_ID" -c "$COMPOSE" -e "$ENV_FILE" \
  --no-public-logs --no-public-sysinfo --no-dev-os --image "$PHALA_OS_IMAGE" --wait

PHALA_CVM_ID="$CVM_ID" ENV_FILE="$ENV_FILE" node .github/scripts/phala-sync-allowed-envs.mjs

require_production_os "after deploy"
echo "deploy-ptx-dev: $CVM_NAME ($CVM_ID) updated on $PHALA_OS_IMAGE"
