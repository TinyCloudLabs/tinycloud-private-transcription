# Optional debug access and log shipping (ptx-dev)

`app-compose.yaml` carries four optional services for operating the dev stack:

| Service | Runs | Purpose |
|---|---|---|
| `debug-ssh` | always (exits without a key) | Key-only SSH into a container that can drive the CVM's Docker engine |
| `debug-ssh-tools` | once per boot | Copies the pinned static `docker` CLI and compose plugin for `debug-ssh` |
| `debug-log-shipper` | always (exits without a token) | Vector: ships every container's logs to Better Stack |
| `probe` | only on demand (`profiles: ["probe"]`) | Read-only status query against both Postgres databases |

Every image is pinned by digest. Nothing here changes the OS image or any other service.

## Enable

Add two values to the sealed env file (`infra/dstack/.env`, never committed), then deploy with
`infra/dstack/deploy-ptx-dev.sh` (README "Deploy / update"). The script also adds new names to the CVM's
`allowed_envs`; dstack drops sealed variables that are not on that list.

| Variable | Value |
|---|---|
| `DEBUG_SSH_AUTHORIZED_KEY` | One SSH **public** key on one line, unquoted, without a `#` comment (`ssh-ed25519 AAAA… name`) |
| `BETTERSTACK_SOURCE_TOKEN` | Ingest token of the Better Stack source `ptx-dev` (platform Vector) |

Each sidecar fails closed: with an empty value, or a value that is not exactly one valid public key,
`debug-ssh` logs why and exits, so nothing listens on port 2222. `debug-log-shipper` exits without a token.

## Connect

`debug-ssh` listens on port 2222, which the dstack gateway exposes as a TLS-terminated TCP route. SSH runs
inside that TLS connection:

```sh
HOST="$(phala cvms get ptx-dev --json | jq -r '"\(.app_id)-2222.\(.gateway.base_domain)"')"
ssh -i ~/.ssh/<debug key> \
  -o ProxyCommand='openssl s_client -quiet -verify_quiet -verify_return_error -verify_hostname %h -connect %h:443 -servername %h' \
  root@"$HOST"
```

On first connect, compare the host key with the fingerprint `debug-ssh` logs at start (`debug-ssh: host
key ...`, visible in Better Stack). The host key lives in the `debug-ssh-hostkeys` volume, so it stays the
same across restarts and redeploys until the sidecar is removed.

The SSH server accepts only public-key authentication for `root` with the one configured key. Passwords,
keyboard-interactive, agent/X11/TCP forwarding and tunnels are off.

In the session:

```sh
docker ps -a                               # every container, including meeting bots (vexa-mtg-*)
docker logs -t <container>
docker exec -it <container> sh
dstack-compose ps                          # `docker compose` on this CVM's project, with its sealed env
```

## Run the probe

```sh
PROBE_MEETING_IDS=101,102 dstack-compose --profile probe run --rm -T probe
```

`PROBE_MEETING_IDS` is a comma-separated list of Vexa meeting ids (anything else exits with status 2). The probe
connects to `postgres` (db `ptx`) and `vexa-postgres` (db `vexa`) with `default_transaction_read_only=on` and a
5 s statement timeout, and prints one JSON line per database:

- `{"probe": "ptx", ...}`: PTX meetings whose `vexa_meeting_id` is listed: id, status, error code, platform,
  timestamps, and `capture_diagnostics` provider status, completion reason, failure stage and transitions.
- `{"probe": "vexa", ...}`: Vexa meetings with those ids: id, platform, status, timestamps, and from `data`
  the status transitions, completion reason, failure stage and join evidence.

It selects no meeting URLs, bot names, metadata, error messages or transcript content. The output goes to the
terminal and, through `debug-log-shipper`, to Better Stack.

## What each sidecar can see

- **`debug-ssh`**: the Docker socket, which gives the session full control of the CVM's containers (the same
  trust as `runtime` and `bot-janitor`, which already mount it), plus read-only copies of the deployed
  compose file and the CVM's decrypted environment (used by `dstack-compose`).
- **`debug-log-shipper`**: the Docker socket, used to read the stdout/stderr of every container, including
  meeting bots and the probe. It sends each line with its container name, image, stream and timestamp to
  `https://s2795440.us-west-2a.betterstackdata.com/` (source `ptx-dev`, table `ptx_dev`, region us_west). Its
  own output is excluded. Delivery is at least once: a line can occasionally arrive twice.
- **`probe`**: the two database passwords and the `ptx` and `vexa` networks; only while it runs.
- **`debug-ssh-tools`**: no network and no socket; it only fills the `debug-ssh-tools` volume.

## Remove

Delete the four services (`debug-ssh-tools`, `debug-ssh`, `debug-log-shipper`, `probe`) and the volumes
`debug-ssh-tools` and `debug-ssh-hostkeys` from `app-compose.yaml`, revert the `:2222` note at the end of the
file, and deploy that change with `infra/dstack/deploy-ptx-dev.sh`. dstack's `compose up --remove-orphans`
removes the containers, and its post-deploy `docker image prune -af` removes the images. The two named volumes
can remain on the CVM's encrypted disk (Docker's default volume prune skips named volumes); they hold only the
SSH host key and the copied docker CLI. Empty `DEBUG_SSH_AUTHORIZED_KEY` and `BETTERSTACK_SOURCE_TOKEN` in the
sealed env file in the same deploy.
