# infra — local meeting-capture rig (Vexa + Jitsi)

Everything a headless E2E needs on one Docker host: the pinned upstream **Vexa** stack (bot API,
CPU Whisper), a local **Jitsi Meet** the bot can join without auth, and the glue (dev CA, network).
No GPU, no external accounts. Docker needs `sudo` on this host; the wrappers already use it.

```
infra/
  certs/gen.sh                 dev CA + leaf cert for jitsi.local            (outputs gitignored)
  vexa/upstream/               git submodule → Vexa-ai/vexa @ pinned SHA      (see vexa/UPSTREAM_PIN)
  vexa/vexa.env                compose interpolation env (dev defaults, no real secrets)
  vexa/docker-compose.override.yml  adds CPU faster-whisper on the vexa network
  vexa/bot/Dockerfile          vexaai/vexa-bot:v012 + our CA in Chromium's NSS store (no source changes)
  vexa/compose.sh              wrapper: upstream compose + our env + overlay
  jitsi/docker-compose.yml     docker-jitsi-meet stable-11146-2 compose, copied verbatim (jitsi/UPSTREAM_PIN)
  jitsi/jitsi.env, jitsi/docker-compose.override.yml, jitsi/compose.sh
```

## Why it is shaped this way (read once)

* Vexa's `POST /bots` **rejects** `meeting_url` that is not `https://`, or targets `localhost`, or is
  an IP literal (SSRF hygiene in `meeting_api/bot_spawn/router.py::_validate_meeting_url`). So local
  Jitsi is served as **`https://jitsi.local:8443`** with a cert from our throwaway CA.
* Vexa's bot launches Chromium **without** `--ignore-certificate-errors` (deliberate upstream choice for
  Google Meet bot-detection). Chromium on Linux trusts user certs from `$HOME/.pki/nssdb`; the bot runs
  as root, so `infra/vexa/bot/Dockerfile` derives `ptx/vexa-bot:v012-devca` from the published bot image
  and adds the CA there. `BROWSER_IMAGE` in `vexa.env` points at it. Upstream sources are untouched.
* Bots are spawned by Vexa's `runtime` as containers on the compose network `vexa-v012_vexa`. Jitsi's
  `web` and `jvb` services join that network with the alias **`jitsi.local`**, so the bot resolves the
  URL in-network. On the host, the Playwright fake participant maps `jitsi.local → 127.0.0.1` via
  `--host-resolver-rules` (nothing to add to /etc/hosts).
* Transcription: Vexa treats STT as an external OpenAI-compatible service. We run
  `fedirz/faster-whisper-server:latest-cpu` (`Systran/faster-whisper-small.en`) as `whisper` on the vexa
  network; the bot posts audio to `http://whisper:8000/v1/audio/transcriptions`.
* Gateway host port is **18066** (upstream default 18056 is taken by the API branch's mock Vexa).

## Bring-up (exact commands, from the repo root)

```bash
# 0. one-time
./infra/certs/gen.sh                                    # dev CA + jitsi.local leaf
cp infra/certs/out/ca.crt infra/vexa/bot/ca.crt
sudo docker build -t ptx/vexa-bot:v012-devca infra/vexa/bot   # derived bot image (pulls vexaai/vexa-bot:v012, ~1.6 GB)
git submodule update --init infra/vexa/upstream         # pinned Vexa checkout (compose files only are used)
./scripts/make-fixture.sh                                # fixtures/alice.wav (espeak-ng in a container)
bun install                                              # playwright for the fake participant

# 1. Vexa (published v012 images; nothing is built except the derived bot image above)
infra/vexa/compose.sh pull
infra/vexa/compose.sh up -d --no-build
infra/vexa/compose.sh ps                                 # wait until every service is healthy (~2 min; whisper downloads the model once)
curl -s localhost:18066/health                           # {"status":"ok","service":"gateway"}
curl -s "localhost:18080/health?force=1"                 # meeting-api: capabilities.stt.state == "configured", probe.ok == true

# 2. Jitsi (needs the vexa network to exist → after step 1)
infra/jitsi/compose.sh up -d
curl -s --cacert infra/certs/out/ca.crt --resolve jitsi.local:8443:127.0.0.1 https://jitsi.local:8443/config.js | grep '^config.bosh'

# 3. mint a Vexa API key (admin token → user → X-API-Key). vexa-smoke.ts does this itself if VEXA_API_KEY is unset.
ADMIN_TOKEN=dev-admin-token ADMIN_API_URL=http://127.0.0.1:18057 infra/vexa/upstream/deploy/compose/bin/provision-token

# 4. the happy-path gate
bun run scripts/vexa-smoke.ts                            # PASS ... "brown fox" attributed to speaker "Alice"
```

Useful:

```bash
bun run scripts/fake-participant.ts --url https://jitsi.local:8443/some-room --seconds 30   # just Alice
infra/vexa/compose.sh logs -f runtime meeting-api        # spawn + lifecycle
sudo docker ps | grep vexa-mtg-                          # live bot containers (name = vexa-mtg-<meeting id>-<uuid8>)
sudo docker logs -f $(sudo docker ps -q -f name=vexa-mtg-) # bot log (join steps, [record-chunker], [mixed], [JitsiSpeakers])
open http://localhost:13000                              # Vexa Terminal UI (dev login: any email)
infra/jitsi/compose.sh down; infra/vexa/compose.sh down -v   # tear down (order matters: jitsi uses the vexa network)
```

Ports (all loopback unless noted): gateway 18066 · admin-api 18057 · meeting-api 18080 · runtime 18090 ·
agent-api 18100 · mcp 18010 · terminal 13000 · postgres 5458 · minio 9000/9001 · whisper 18083 ·
jitsi https 8443 / http 8001 · jitsi JVB **0.0.0.0:10000/udp** (media; the only non-loopback port).

## Host gotcha we hit
Containers on bridge networks had no egress and DNS on this host: Docker's base iptables jumps
(`FORWARD → DOCKER-USER/DOCKER-FORWARD`, nat `PREROUTING/OUTPUT → DOCKER`, docker0 MASQUERADE) had been
flushed by something else (tailscale/firewall reload). Restored with `iptables -I ...` (see the branch's
first commits' history / ask the capture worker); a `sudo systemctl restart docker` also fixes it but
restarts every container on the box.
