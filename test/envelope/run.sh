#!/usr/bin/env bash
# ptx-batch memory envelope. CI: .github/workflows/batch-envelope.yml. Needs docker (compose v2, cgroup v2), curl, jq,
# python3 and openssl on the host; ENVELOPE_IMAGE is the api image built from this commit.
#
# Runs infra/dstack-batch/app-compose.yaml as deployed (memory limits, no swap, Postgres settings) with that image,
# pinned to one CPU like tdx.small, and Tinfoil replaced by test/envelope/mock-tinfoil.ts (test/envelope/compose.ci.yaml).
# Then, only through the public API:
#   1. the fresh install reports admission closed; the admin key opens it;
#   2. three tenants create and PUT a synthetic 2-hour stereo 128 kbps MP3 at once (BATCH_MAX_CONCURRENT_UPLOADS = 3);
#   3. the two later uploads are cancelled, and the worker runs the oldest: ffmpeg decode per channel, VAD, one mocked
#      provider call per region; the job must complete with its audio deleted;
#   4. while it processes, a burst of BURST_CLIENTS (30) parallel clients polls GET /v1/transcriptions/{id} for
#      BURST_SECONDS; every poll must answer 200.
# Fails on a timeout, an OOM kill or a restart in any container; prints peak memory per container (and to
# $GITHUB_STEP_SUMMARY when set).
set -euo pipefail

: "${ENVELOPE_IMAGE:?ENVELOPE_IMAGE (the api image built from this commit) is required}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
export ENVELOPE_IMAGE ENVELOPE_DIR="$REPO/test/envelope"
WORK="$(mktemp -d "${RUNNER_TEMP:-/tmp}/ptx-envelope.XXXXXX")"
PROCESS_DEADLINE_SECONDS="${PROCESS_DEADLINE_SECONDS:-1200}"
DURATION_SECONDS=7199 # the 7,200 s cap minus room for MP3 encoder padding
URL=http://127.0.0.1:8080
MOCK=http://127.0.0.1:18081
SERVICES=(api upload-worker postgres)
BURST_CLIENTS=30
BURST_SECONDS=15
MP3="$WORK/recording.mp3"

compose() {
  docker compose -p ptx-envelope -f "$REPO/infra/dstack-batch/app-compose.yaml" -f "$ENVELOPE_DIR/compose.ci.yaml" \
    --env-file "$WORK/sealed.env" "$@"
}
fail() { echo "::error title=Batch envelope::$1"; exit 1; }
mib() { awk -v b="$1" 'BEGIN { printf "%.0f", b / 1048576 }'; }

finish() {
  local code=$?
  rm -f "$WORK/sampling"
  if [ "$code" -ne 0 ] && [ -f "$WORK/sealed.env" ]; then compose logs --no-color --tail 200 || true; fi
  if [ -f "$WORK/sealed.env" ]; then compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
  exit "$code"
}
trap finish EXIT

echo "::group::Generate a ${DURATION_SECONDS} s stereo 128 kbps MP3"
# Mostly a -60 dBFS noise floor. Channel 0 speaks 3 s every 20 s plus a 45 s monologue every 10 min (exercises the
# 30 s region split); channel 1 speaks 3 s every 20 s, 10 s later. Speech-like: 4-5 Hz amplitude modulation.
gate0='lt(mod(t,20),3)+between(mod(t,600),300,345)'
gate1='between(mod(t,20),10,13)'
started=$SECONDS
docker run --rm --user "$(id -u):$(id -g)" --volume "$WORK:/out" "$ENVELOPE_IMAGE" \
  ffmpeg -hide_banner -loglevel error -nostdin -y \
  -f lavfi -i "sine=f=220:r=44100" -f lavfi -i "sine=f=330:r=44100" \
  -f lavfi -i "anoisesrc=r=44100:a=0.001:c=pink:s=1" -f lavfi -i "anoisesrc=r=44100:a=0.001:c=pink:s=2" \
  -filter_complex "[0]tremolo=f=4:d=0.7,volume='if(${gate0},0.5,0)':eval=frame[v0];[1]tremolo=f=5:d=0.7,volume='if(${gate1},0.5,0)':eval=frame[v1];[v0][2]amix=inputs=2:duration=shortest:normalize=0[c0];[v1][3]amix=inputs=2:duration=shortest:normalize=0[c1];[c0][c1]amerge=inputs=2[out]" \
  -map "[out]" -t "$DURATION_SECONDS" -c:a libmp3lame -b:a 128k /out/recording.mp3
SIZE="$(stat -c %s "$MP3")"
SHA="$(sha256sum "$MP3" | cut -d' ' -f1)"
echo "recording.mp3: $SIZE bytes in $((SECONDS - started)) s"
[ "$SIZE" -le 120960000 ] || fail "the fixture is over the 120,960,000-byte upload cap"
echo "::endgroup::"

echo "::group::Start infra/dstack-batch/app-compose.yaml with the CI overlay"
keys="$(docker run --rm "$ENVELOPE_IMAGE" bun -e '
  const { mintBootstrapKeys } = await import("./src/api/bootstrap-keys.ts");
  const minted = mintBootstrapKeys([
    { id: "envelope-client", project: "envelope", scopes: ["transcriptions:*"] },
    { id: "envelope-admin", project: "ops", scopes: ["admin:*"] },
  ]);
  console.log(JSON.stringify({ client: minted.keys[0].key, admin: minted.keys[1].key, env: minted.env }));')"
CLIENT_KEY="$(jq -r .client <<<"$keys")"
ADMIN_KEY="$(jq -r .admin <<<"$keys")"
(
  umask 077
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'BATCH_TINFOIL_API_KEY=envelope-mock\n'
  printf "PTX_BOOTSTRAP_KEYS='%s'\n" "$(jq -r .env <<<"$keys")"
) > "$WORK/sealed.env"
compose up -d --wait --wait-timeout 300
config="$(compose config --format json)"

declare -A CID CGROUP PID LIMIT
for s in "${SERVICES[@]}"; do
  CID[$s]="$(compose ps -q "$s")"
  id="$(docker inspect -f '{{.Id}}' "${CID[$s]}")"
  PID[$s]="$(docker inspect -f '{{.State.Pid}}' "${CID[$s]}")"
  CGROUP[$s]=""
  for dir in "/sys/fs/cgroup/system.slice/docker-$id.scope" "/sys/fs/cgroup/docker/$id"; do
    if [ -r "$dir/memory.stat" ]; then CGROUP[$s]="$dir"; fi
  done
  [ -n "${CGROUP[$s]}" ] || fail "no cgroup v2 directory found for $s"
  LIMIT[$s]="$(jq -r --arg s "$s" '.services[$s].mem_limit' <<<"$config")"
  [[ "${LIMIT[$s]}" =~ ^[0-9]+$ ]] || fail "$s has no mem_limit in the deploy compose"
  [ "$(cat "${CGROUP[$s]}/memory.max")" = "${LIMIT[$s]}" ] || fail "$s runs with memory.max $(cat "${CGROUP[$s]}/memory.max"), not the compose's ${LIMIT[$s]}"
  [ "$(cat "${CGROUP[$s]}/memory.swap.max")" = 0 ] || fail "$s may swap (memory.swap.max=$(cat "${CGROUP[$s]}/memory.swap.max"))"
  echo "$s: memory.max=$(mib "${LIMIT[$s]}") MiB, swap 0, cgroup ${CGROUP[$s]}"
done
echo "::endgroup::"

# Peak unreclaimable memory per container, anon + shmem from memory.stat (every process in its cgroup: bun, ffmpeg,
# ffprobe, the healthcheck's bun; shmem holds Postgres shared_buffers), overall and while the poll burst runs, and
# peak RSS per process name, sampled at 5 Hz from the host so the sampler adds nothing to the containers.
touch "$WORK/sampling"
sampler_args=()
for s in "${SERVICES[@]}"; do sampler_args+=("$s=${CGROUP[$s]}"); done
python3 - "$WORK" "${sampler_args[@]}" <<'PY' &
import json, os, sys, time
work, pairs = sys.argv[1], [arg.split("=", 1) for arg in sys.argv[2:]]
anon, burst, rss = {}, {}, {}
def read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""
while os.path.exists(os.path.join(work, "sampling")):
    for name, cgroup in pairs:
        stat = dict(line.split() for line in read(f"{cgroup}/memory.stat").splitlines() if line.count(" ") == 1)
        held = int(stat.get("anon", 0)) + int(stat.get("shmem", 0))
        anon[name] = max(anon.get(name, 0), held)
        if os.path.exists(os.path.join(work, "burst")):
            burst[name] = max(burst.get(name, 0), held)
        for pid in read(f"{cgroup}/cgroup.procs").split():
            fields = dict(line.split(":", 1) for line in read(f"/proc/{pid}/status").splitlines() if ":" in line)
            if "VmRSS" in fields and "Name" in fields:
                key = f"{name}/{fields['Name'].strip()}"
                rss[key] = max(rss.get(key, 0), int(fields["VmRSS"].split()[0]) * 1024)
    time.sleep(0.2)
with open(os.path.join(work, "peaks.json"), "w") as f:
    json.dump({"anon": anon, "burst": burst, "rss": rss}, f)
PY
sampler=$!

echo "::group::Admission starts closed; open it"
for _ in $(seq 1 60); do
  [ "$(curl -fsS "$URL/health" 2>/dev/null | jq -r '.checks.upload_transcription.ready // false')" = true ] && break
  sleep 2
done
admin() { curl -fsS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' "$@" "$URL/v1/admin/admission"; }
mode="$(admin | jq -r .mode)"
[ "$mode" = closed ] || fail "a fresh install must start with admission closed (got $mode)"
admin -X PUT -d '{"mode":"open"}' | jq -e '.mode == "open"' >/dev/null || fail "admission did not open"
echo "::endgroup::"

echo "::group::Three concurrent uploads"
declare -A TENANT JOB
api() { curl -fsS -H "Authorization: Bearer $CLIENT_KEY" -H "X-Tenant-Ref: ${TENANT[$1]}" "${@:2}"; }
create_body="$(jq -nc --argjson size "$SIZE" --arg sha "$SHA" '{content_type: "audio/mpeg", byte_size: $size, sha256: $sha, language: "en", channel_mode: "separate"}')"
put_pids=()
started=$SECONDS
for i in 1 2 3; do
  TENANT[$i]="$(printf 'envelope-%s' "$i" | sha256sum | cut -d' ' -f1)"
  created="$(api "$i" -X POST "$URL/v1/transcriptions" -H "Idempotency-Key: envelope-$i" -H 'Content-Type: application/json' -d "$create_body")"
  JOB[$i]="$(jq -r .id <<<"$created")"
  curl -sS -o "$WORK/put.$i.json" -w '%{http_code}' -T "$MP3" -H 'Expect:' -H 'Content-Type: audio/mpeg' \
    -H "Authorization: Bearer $(jq -r .upload.capability <<<"$created")" "$URL$(jq -r .upload.path <<<"$created")" > "$WORK/put.$i.code" &
  put_pids+=($!)
done
for p in "${put_pids[@]}"; do wait "$p"; done
UPLOAD_SECONDS=$((SECONDS - started))
for i in 1 2 3; do
  [ "$(cat "$WORK/put.$i.code")" = 201 ] || fail "upload $i answered $(cat "$WORK/put.$i.code"): $(cat "$WORK/put.$i.json")"
done
echo "3 x $SIZE bytes accepted in ${UPLOAD_SECONDS} s"
# The worker claims the oldest upload first and only one job at a time, so cancelling the two later ones leaves it alone.
keep="$(for i in 1 2 3; do printf '%s\t%s\n' "$(api "$i" "$URL/v1/transcriptions/${JOB[$i]}" | jq -r .uploaded_at)" "$i"; done | sort | head -1 | cut -f2)"
for i in 1 2 3; do
  [ "$i" = "$keep" ] && continue
  status="$(api "$i" -X POST "$URL/v1/transcriptions/${JOB[$i]}/cancel" | jq -r .status)"
  [ "$status" = cancelled ] || fail "cancelling job $i left it $status"
done
echo "::endgroup::"

echo "::group::Process the 2-hour stereo job (deadline ${PROCESS_DEADLINE_SECONDS} s)"
poll_burst() { # one client: GET the job until the burst window closes; one HTTP code per line
  local until=$((SECONDS + BURST_SECONDS))
  while [ "$SECONDS" -lt "$until" ]; do
    curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $CLIENT_KEY" -H "X-Tenant-Ref: ${TENANT[$keep]}" \
      "$URL/v1/transcriptions/${JOB[$keep]}" || true # a failed request still prints 000
  done
}
deadline=$((SECONDS + PROCESS_DEADLINE_SECONDS))
burst_stage=""
while :; do
  job="$(api "$keep" "$URL/v1/transcriptions/${JOB[$keep]}")"
  status="$(jq -r .status <<<"$job")"
  echo "$(date -u +%T) status=$status $(jq -c .progress <<<"$job")"
  case "$status" in completed | failed | cancelled) break ;; esac
  [ "$SECONDS" -lt "$deadline" ] || fail "the job did not finish within ${PROCESS_DEADLINE_SECONDS} s"
  if [ "$status" = processing ] && [ -z "$burst_stage" ]; then
    burst_stage="$(jq -r .progress.stage <<<"$job")"
    echo "burst: $BURST_CLIENTS parallel pollers for $BURST_SECONDS s (job stage $burst_stage)"
    touch "$WORK/burst"
    burst_pids=()
    for c in $(seq 1 "$BURST_CLIENTS"); do poll_burst > "$WORK/burst.$c" & burst_pids+=($!); done
    for p in "${burst_pids[@]}"; do wait "$p"; done
    rm -f "$WORK/burst"
    continue
  fi
  sleep 2
done
echo "::endgroup::"
rm -f "$WORK/sampling"
wait "$sampler"

[ "$status" = completed ] || fail "the job ended $status: $(jq -c .error <<<"$job")"
[ -n "$burst_stage" ] || fail "the job finished before the poll burst could start"
BURST_POLLS="$(cat "$WORK"/burst.* | wc -l)"
burst_bad="$(cat "$WORK"/burst.* | grep -cv '^200$' || true)"
[ "$burst_bad" = 0 ] || fail "$burst_bad of $BURST_POLLS burst polls did not answer 200: $(cat "$WORK"/burst.* | sort | uniq -c | tr '\n' ' ')"

result="$(api "$keep" "$URL/v1/transcriptions/${JOB[$keep]}/result")"
stats="$(curl -fsS "$MOCK/stats")"
regions="$(jq -r .progress.regions_total <<<"$job")"
segments="$(jq -r '.segments | length' <<<"$result")"
calls="$(jq -r .calls <<<"$stats")"
jq -e '.channels == 2 and (.speakers | length) == 2' <<<"$result" >/dev/null || fail "the result is not two speakers"
[ "$regions" -ge 600 ] || fail "the VAD found only $regions regions"
[ "$calls" = "$regions" ] || fail "$calls provider calls for $regions regions"
[ "$segments" = "$regions" ] || fail "$segments segments for $regions regions"
jq -e '.bad_wav == 0 and .max_wav_bytes <= 960100' <<<"$stats" >/dev/null || fail "a region was not a <= 30 s WAV: $stats"
jq -e '.retention.audio == "deleted"' <<<"$job" >/dev/null || fail "the audio was not deleted: $(jq -c .retention <<<"$job")"
processing="$(jq -r '((.finished_at | sub("\\.[0-9]+"; "") | fromdateiso8601) - (.processing_started_at | sub("\\.[0-9]+"; "") | fromdateiso8601))' <<<"$job")"

breach=""
rows=""
for s in "${SERVICES[@]}"; do
  hwm="$(awk '$1 == "VmHWM:" { print $2 * 1024 }' "/proc/${PID[$s]}/status")"
  anon="$(jq -r --arg s "$s" '.anon[$s] // 0' "$WORK/peaks.json")"
  burst="$(jq -r --arg s "$s" '.burst[$s] // 0' "$WORK/peaks.json")"
  procs="$(jq -r --arg s "$s" '.rss | to_entries | map(select(.key | startswith($s + "/"))) | sort_by(-.value)
    | map("\(.key | split("/")[1]) \((.value / 1048576) | round)") | join(", ")' "$WORK/peaks.json")"
  peak="$(cat "${CGROUP[$s]}/memory.peak")"
  oom="$(awk '$1 == "oom_kill" { print $2 }' "${CGROUP[$s]}/memory.events")"
  restarts="$(docker inspect -f '{{.RestartCount}}' "${CID[$s]}")"
  killed="$(docker inspect -f '{{.State.OOMKilled}}' "${CID[$s]}")"
  rows+="| $s | $(mib "${LIMIT[$s]}") | $(mib "$hwm") | $(mib "$anon") | $(mib "$burst") | $procs | $(mib "$peak") | $oom | $restarts |"$'\n'
  if [ "$oom" != 0 ] || [ "$restarts" != 0 ] || [ "$killed" != false ]; then breach+="$s (oom_kill=$oom restarts=$restarts OOMKilled=$killed) "; fi
done

report="### ptx-batch memory envelope (tdx.small limits, 1 CPU)

- Recording: ${DURATION_SECONDS} s stereo 128 kbps MP3, $SIZE bytes; 3 concurrent PUTs in ${UPLOAD_SECONDS} s
- Job: completed in ${processing} s of processing; $regions regions, $calls mocked provider calls, audio deleted
- Poll burst: $BURST_CLIENTS parallel clients x ${BURST_SECONDS} s during $burst_stage, $BURST_POLLS GETs, all 200

| service | limit MiB | pid 1 peak RSS (VmHWM) MiB | peak anon+shmem, whole container MiB | anon+shmem peak during the poll burst MiB | peak RSS per process MiB | cgroup peak incl. page cache MiB | oom_kill | restarts |
|---|---|---|---|---|---|---|---|---|
$rows"
echo "$report"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$report" >> "$GITHUB_STEP_SUMMARY"; fi
[ -z "$breach" ] || fail "memory envelope breached: $breach"
