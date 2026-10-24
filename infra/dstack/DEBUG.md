# Optional debug access and log shipping (ptx-dev)

`app-compose.yaml` carries four optional services for operating the dev stack:

| Service | Runs | Purpose |
|---|---|---|
| `debug-ssh` | always (refuses to start without a valid inlined key) | Key-only SSH into a container that can drive the CVM's Docker engine |
| `debug-ssh-tools` | once per boot | Copies the pinned static `docker` CLI and compose plugin for `debug-ssh` |
| `debug-log-shipper` | always (refuses to start without a token) | Vector: ships the logs of an allowlist of containers to Better Stack |
| `probe` | only on demand (`profiles: ["probe"]`) | Read-only status query against both Postgres databases |

Every image is pinned by digest. Nothing here changes the OS image or any other service.

**Whoever holds the debug SSH key is root-equivalent on the CVM.** The session has the Docker socket (full
control of every container, including starting a privileged one) and a read-only copy of the CVM's
decrypted environment, which holds every sealed value: database passwords, the Vexa admin token, MinIO
credentials, API bootstrap keys and the Better Stack token.

## Enable

1. **SSH key, in the compose file.** In `app-compose.yaml`, `debug-ssh` → `environment`, replace the
   placeholder `DEBUG_SSH_AUTHORIZED_KEY: "REPLACE_AT_DEPLOY"` with one SSH **public** key on one line
   (`ssh-ed25519 AAAA… name`), in the final commit before the deploy. The key is part of the measured compose,
   so changing who can log in changes the compose hash. It is not a secret; never put a private key there.
   It is not read from the sealed env; remove any `DEBUG_SSH_AUTHORIZED_KEY` line from your env file.
2. **Better Stack token, in the sealed env.** Add `BETTERSTACK_SOURCE_TOKEN` (ingest token of the Better
   Stack source `ptx-dev`, platform Vector) to the sealed env file (`infra/dstack/.env`, never committed),
   unquoted.
3. Deploy with `infra/dstack/deploy-ptx-dev.sh` (README "Deploy / update"). Its allowed_envs sync adds new
   env-file names to the CVM's `allowed_envs`; dstack drops sealed variables that are not on that list.

Each sidecar fails closed, and with `restart: unless-stopped` Docker restarts it in a back-off loop while it
is misconfigured; nothing listens in between:

- `debug-ssh` logs why and stops before sshd starts when the value is empty, still `REPLACE_AT_DEPLOY`, or
  not exactly one valid public key. Nothing listens on port 2222.
- `debug-log-shipper` logs why and stops before Vector starts when the token is empty.

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
  timestamps, and `capture_diagnostics` provider status, completion reason, failure stage, transitions and
  `stop_requested_by` (`user` or `join_deadline`).
- `{"probe": "vexa", ...}`: Vexa meetings with those ids: id, platform, status, timestamps, and from `data`
  the status transitions, completion reason, failure stage and join evidence.

It selects no meeting URLs, bot names, metadata, error messages or transcript content. The output goes to the
terminal and, through `debug-log-shipper`, to Better Stack.

**Accepted limit: read-only is client-side.** The probe connects as the superuser of each database: `ptx`
(the bootstrap superuser of the `ptx` database, `rolsuper=t`) on `ptx` and `postgres` on `vexa`. `default_transaction_read_only` is a setting the client chooses, so
the server does not enforce it; the fixed SQL is what keeps the probe read-only. Neither database has a
read-only role, and the stack cannot create one without a migration: `vexa-postgres` mounts no init scripts,
and Postgres runs `docker-entrypoint-initdb.d` only on an empty data directory, so an init script would never
run against the existing ptx-dev volume. Adding a role means changing `vexa-postgres` or running SQL as the
superuser, both outside this change.

## What is shipped

`debug-log-shipper` reads container logs through the Docker socket and ships only an allowlist. The
`allowlist` filter in its `VECTOR_CONFIG_YAML` keeps a line when either holds:

- the container's `com.docker.compose.service` label is one of `meeting-api`, `gateway`, `api`, `worker`,
  `probe` (including `run --rm` one-offs) or `debug-ssh`;
- the container name starts with `vexa-mtg-` (meeting bots; the Vexa runtime starts them, so they are not
  compose services and carry no compose label).

Every other container is dropped, among them `admin-api`, `postgres`, `vexa-postgres`, `signal-capture`,
`runtime`, `whisper`, `redis`, `vexa-redis`, `minio`, `bot-janitor`, the provisioners and the shipper itself.
Each shipped line carries its container name, image, stream and timestamp and goes to
`https://s2795440.us-west-2a.betterstackdata.com/` (source `ptx-dev`, table `ptx_dev`, region us_west).
Delivery is at least once: a line can occasionally arrive twice.

What the allowlisted containers log:

- **bots, `meeting-api`, `gateway`**: allowlist log sanitizers; enums, numbers and a hashed meeting id.
- **`api`, `worker`**: internal ids, stages and codes; an uncaught error prints Bun's default stack trace.
- **`probe`**: meeting ids, statuses, timestamps, Vexa status transitions and join evidence (enums plus short
  diagnostic strings with URLs and bearer tokens redacted).
- **`debug-ssh`**: sshd at VERBOSE: key fingerprints and the gateway-side source address.

### Widening the allowlist

Add a compose service name to the `includes([...])` list in the `allowlist` condition (or another name
prefix next to `starts_with(name, "vexa-mtg-")`), then deploy. Widening is the owner's decision, because the
excluded services can log identifiers or secrets to a third party:

- **`admin-api`** (upstream v012): the uvicorn access log prints full request paths (user ids, token-issuance
  paths, the provisioning account email); an unhandled error's traceback can include SQL bind parameters,
  such as an API key value or user records with webhook settings.
- **`runtime`** (upstream v012): workload ids in the access log; the raw Docker error text on a spawn failure.
- **`postgres`, `vexa-postgres`**: on errors, the failing statement and its DETAIL line; unique-violation
  DETAIL lines include the key values.
- **`signal-capture`**: Signal Desktop's own stdout/stderr, unfiltered and not audited; unhandled route
  errors go through Hono's default `console.error(err)`.
- **`whisper`**: transcript text at INFO on its WebSocket streaming endpoint (nothing in this stack calls it).

## What each sidecar can see

- **`debug-ssh`**: root-equivalent (see the top of this file): the Docker socket, plus read-only copies of
  the deployed compose file and the CVM's decrypted environment (used by `dstack-compose`). Anyone with the
  socket can also read the Better Stack token from the shipper's container config.
- **`debug-log-shipper`**: the Docker socket, used to read container logs; only allowlisted lines leave the
  CVM.
- **`probe`**: the two database passwords and the `ptx` and `vexa` networks; only while it runs.
- **`debug-ssh-tools`**: no network and no socket; it only fills the `debug-ssh-tools` volume.

## Remove

All of these, in one change, deployed with `infra/dstack/deploy-ptx-dev.sh`:

1. `app-compose.yaml`: delete the four services (`debug-ssh-tools`, `debug-ssh`, `debug-log-shipper`,
   `probe`) and the two volumes `debug-ssh-tools` and `debug-ssh-hostkeys`; revert the header comment
   (the `BETTERSTACK_SOURCE_TOKEN` line) and the `:2222` note at the end of the file.
2. `test/unit/deploy-config.test.ts`: the rendered service count goes back from 22 to 19.
3. Revert the debug-sidecar parts of `README.md` ("Deploy / update": the DEBUG.md link), `.env.example`
   (`BETTERSTACK_SOURCE_TOKEN`) and the `CHANGELOG.md` entry; delete this file (`infra/dstack/DEBUG.md`).
4. Remove `BETTERSTACK_SOURCE_TOKEN` from the sealed env file.

dstack's `compose up --remove-orphans` removes the containers, and its post-deploy `docker image prune -af`
removes the images. The two named volumes can remain on the CVM's encrypted disk (Docker's default volume
prune skips named volumes); they hold only the SSH host key and the copied docker CLI.

Then, outside the repository:

5. **Better Stack**: revoke or rotate the ingest token of the source `ptx-dev`, so a leaked copy (it was in
   the sealed env and readable through the Docker socket) cannot write to it. Decide whether to keep the
   lines already shipped until the source's retention expires or to purge them (delete the source or its
   data); they can contain the identifiers listed in "What is shipped".
6. Retire the operator's debug SSH key pair.
