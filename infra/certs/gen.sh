#!/usr/bin/env bash
# Dev-only PKI for the capture rig: a throwaway CA + a leaf cert for the local Jitsi hostname.
# Why: Vexa's meeting-api refuses non-https / IP-literal / localhost meeting URLs, and the Vexa
# bot's Chromium deliberately does NOT ignore TLS errors, so local Jitsi must present a cert the
# bot trusts. The CA is baked into the derived bot image (infra/vexa/bot/Dockerfile) and the leaf is
# mounted into jitsi-web. Outputs land in infra/certs/out/ (gitignored). Idempotent.
set -euo pipefail
OUT="$(cd "$(dirname "$0")" && pwd)/out"
HOST="${JITSI_HOST:-jitsi.local}"
mkdir -p "$OUT"
if [[ -f "$OUT/ca.crt" && -f "$OUT/jitsi.crt" ]]; then echo "certs exist in $OUT"; exit 0; fi
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -sha256 \
  -subj "/CN=ptx-dev-ca" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$OUT/ca.key" -out "$OUT/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=$HOST" -keyout "$OUT/jitsi.key" -out "$OUT/jitsi.csr" 2>/dev/null
printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' "$HOST" > "$OUT/leaf.ext"
openssl x509 -req -in "$OUT/jitsi.csr" -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" -CAcreateserial \
  -days 3650 -sha256 -extfile "$OUT/leaf.ext" -out "$OUT/jitsi.crt" 2>/dev/null
rm -f "$OUT/jitsi.csr" "$OUT/leaf.ext" "$OUT/ca.srl"
chmod 644 "$OUT"/*.key "$OUT"/*.crt   # jitsi-web runs unprivileged and must read the key
echo "wrote $OUT/{ca.crt,ca.key,jitsi.crt,jitsi.key} for $HOST"
