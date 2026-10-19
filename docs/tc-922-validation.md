# TC-922: three-hour batch upload boundary

The batch API advertises nominal `max_duration_seconds=10800`, inclusive raw
`accepted_max_duration_seconds=11101`, and inclusive `max_bytes=186496800`. It emits no
`duration_grace_seconds`. Create/PUT and Bun's HTTP body limit share the byte cap; worker decode uses the accepted
duration. Default and shipped-compose API concurrent reservations are 1,864,968,000 bytes (ten caps); the daily tenant budget
is 559,490,400 bytes (three caps).

Raw ffprobe duration is compared before millisecond rounding. Exactly 11,101 seconds is accepted; one 16 kHz sample
above it rejects. Exactly 11,100 decoded seconds of the measured MP3 reported 11,100.029388 raw seconds: a strict
11,100 raw ceiling rejected that file. The accepted raw ceiling also admits about one second of genuinely longer
content beyond 11,100 seconds. It is not a decoded-content duration guarantee.

The worker processing ceiling remains 14,400 seconds (4 h), upload deadline 7,200 seconds, PUT deadline 1,800 seconds,
and rate floor 32,768 B/s. Model/provider, feature flags, channel/file policy, Docker base image and deployment image
pin are unchanged. Full-cap transfer within 1,800 seconds needs about 103,609 B/s; the rate floor alone does not
guarantee timely completion.

## Verification on this change

Baseline was pinned before source edits to `origin/main` `b745636fe3c21cada7840777c8912d30d69e6055`.
The main deployment manifest pins image `508cb0be60a27e6b2bb4eefd888ad7c98954c3e5` with digest
`sha256:72568fe357e87aefb13a4430b0124b16a4c5e98395281e80e9ee09471c9aaf4d`; this change does not alter it.

- Before source edits: `bun --no-env-file test test/unit/batch-duration.test.ts test/unit/batch.test.ts`, exit 1,
  **56 pass / 5 fail**. The failures exercised create parsing and raw duration admission. Incidental arithmetic and
  config-default assertions were removed before this recorded run.
- After minimal source edits: the same command, exit 0, **61 pass / 0 fail**.
- After the TC-959 lead reported `window closed`, the same new API consumer tests ran on a `git archive` export of
  the pinned old main (only the new test file and the lock-matched dependency link were added): exit 1,
  **2 pass / 8 fail**. Candidate: exit 0, **10 pass / 0 fail**.
- Focused batch unit/API/worker suites: exit 0, **183 pass / 0 fail** (23.766 s).
- All unit/integration test files except the two Docker-compose suites: exit 1, **588 pass / 2 fail** across 64 files
  (290.029 s). The unchanged meeting tests `a heart-beating admission is never overlapped; a stopped one yields once,
  bounded` (two-second bot-dispatch timeout) and `gap fill never fetches the recording of a meeting that is being
  deleted (TC-758)` (`noop` versus `processed`) both passed an isolated rerun: exit 0, **2 pass / 0 fail**. These
  broad-run failures remain part of the evidence; no meeting code or tests were changed to hide them.
- `bun --no-env-file run typecheck`: exit 0 (13.944 s). The repository defines no lint command/config;
  `git diff --check` is the whitespace check.
- `bun --no-env-file test/support/batch-duration-smoke.ts /tmp/tc922-private-3h-evidence/http-smoke`: exit 0
  (8.883 s), production HTTP entrypoint + durable worker + loopback provider. A real 186,496,800-byte padded short MP3
  passed create/PUT and completed; cap + 1 create returned 413. Synthetic raw 11101 equality and 11100.029388 MP3
  padding metadata passed and completed; raw 11101.0000625 returned 422 without dispatch. Eight real provider HTTP
  dispatches used the unchanged model, and every decoder command received the 355,232,000-byte per-channel cap.

Service-backed commands used `nice -n 10 taskset -c 0`; exact argv, cwd, exit codes and logs are retained in
`/tmp/tc922-private-3h-evidence/*-result.json` and `run-check.py`. The broad command selects every
`test/{unit,integration}/*.test.ts` except `deploy-config.test.ts` and `deploy-config-batch.test.ts`, whose Docker
commands were prohibited on this host. Final-head CI must cover the full Docker-backed configuration/image lanes.
Local versions were Bun 1.4.3, native Postgres 14, extracted Redis 6 and cached static ffmpeg 7.0.2; they differ from
CI/shipped images. The initial host ffmpeg 4.4 fixture-graph failure and a float32 storage assertion correction are
retained separately, not counted as feature RED. Unit probe assertions check millisecond rounding directly; database
assertions allow the existing `real` column's float32 representation. No schema change was made.

No Docker/compose operations, production requests or paid provider calls were made. All own API/mock ports and native
Postgres/Redis ports were verified closed, PID files absent, stop commands exit 0, and owned native service data removed
at 23:09:11Z. This released the host slot for OpenKey Check2. No three-hour Docker envelope was rerun.

The new API regressions exercise exact public capabilities, full-cap create equality/+1, inclusive reservation/daily
budgets from both defaults and the shipped compose environment, small streamed PUT equality/+1, raw equality/+sample/padded MP3 rejection decisions and cleanup, full accepted
tail dispatch with a scaled eight-second fixture, and unchanged ordinary notes. Metadata stubs isolate the duration
comparison; they do not claim a new three-hour encoder or ASR run. The manual replay is
`test/support/batch-duration-smoke.ts`, against an isolated loopback `tc922` database, production HTTP API entrypoint,
durable worker and local mock provider. It also exercises a real full-byte-cap HTTP body using short audio with legal
ID3 padding, avoiding a long encode/decode and a whole-body heap buffer.

The first PR CI head `a7093ab5aa29289979d091e3e66c5a54212c7e1a` exposed the shipped compose
API's old explicit reservation/daily overrides. Both are corrected to the approved values; the image pin, other
limits and runtime source are unchanged. API budget regressions now consume shipped compose values as well as
defaults. The correction is gated by the shipped-profile API consumer tests and a fresh HTTP budget replay; see the PR for
the latest exact head and results. Service-backed local checks wait for the coordinated host reservation release.

## Held capacity evidence and limits

The accepted prior same-image/current-main assessment is `/tmp/tc3h-sol-0447af13/REPORT.md`, SHA256
`eb335518156f8755edc7b481ceaf429f52f7437d936f1d6c28b14d9480c49742`; its `manifest.json` SHA256 is
`c6d689bb109d0a03c531c6232f45ecc76efaec5c76ccf74a890077bc1c5447ab`. The temporary five-file prototype
`candidate-raw-11101.patch`, SHA256 `fd530577d6dfac7e86d63456ab9c6a09f38e1c43654aaaa225fc128101dbea43`, was not
applied or copied. Implementation is fresh against current main; stale PR #81 was not grafted.

- Six 2 h/3 h/3 h 5 min MP3 jobs completed with full accepted tails and no OOM/restarts under API+worker 320 MiB,
  one CPU and no swap, using a mock provider. Exact byte cap 186,496,800 was accepted at create and three real PUTs;
  cap + 1 rejected at create. Raw 11101.000000 accepted; 11101.000063 rejected. This envelope is not rerun here.
- Worst observed worker anon+shmem was 214.86 MiB and process HWM 215.32 MiB. Sampled `memory.current` including
  cache reached 320 MiB; kernel `memory.peak` was unavailable. Shared-host timings are not uncontended throughput.
- Validation scope is **MP3/AAC only; WAV ≤ max_bytes**. Generic 11,100-second AAC/MP4 was admitted then cancelled
  before processing. Actual mobile encoders/full AAC worker processing and long durationless WebM are unverified.
  A 16 kHz mono s16le WAV of 11,100 seconds is 355,200,078 bytes and rejects 413 under the approved shared byte cap.
- Hosted ASR latency/quality and per-note dollar ceiling are **unknown**. No paid requests were made. The 3 h 5 min
  diarized mock job took 2,365.218 seconds, with 942 calls / 6,428.35 audio-seconds versus 610 / 4,168.20 at 2 h
  (about 1.54×). These are not dollar costs. Quoted Voxtral rates of $0.20/M input and $0.60/M output tokens do not
  establish per-note cost without billed usage.
- Pause admission and **drain to zero before release windows**: ten serial long jobs can exceed the maximum
  300-minute deployment drain window. Keep release order **ptx first, then Exo #405**. Miller owns final-head reviews;
  Sam owns the release gate. This PR authorizes no deployment, merge or image pin change and does not resolve Steer
  `ask/tc-922-duration-boundary` or create a deployment card.

Old PR #81's mono 10,799-second, pre-#105/#109 evidence, no-grace 181,440,000-byte policy and 6 h worker change do not
validate this contract. It is to be superseded only after the replacement PR is open.
