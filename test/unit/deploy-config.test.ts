/**
 * The CVM deployment must enable google_meet. The code default for ENABLED_PLATFORMS is
 * "jitsi" (src/config.ts), so a compose file that omits the variable silently ships a
 * jitsi-only API — which is exactly how tinycloud.chat ended up answering
 * 400 unsupported_platform ("The google_meet platform was detected but is not enabled on
 * this deployment.") for every valid https://meet.google.com/<code>.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOOTSTRAP_KEYS_ENV, mintBootstrapKeys, parseBootstrapKeys } from "../../src/api/bootstrap-keys.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const compose = readFileSync(new URL("../../infra/dstack/app-compose.yaml", import.meta.url), "utf8");
const envExample = readFileSync(new URL("../../infra/dstack/.env.example", import.meta.url), "utf8");
const seatBoot = readFileSync(new URL("../../infra/signal-seat/boot.sh", import.meta.url), "utf8");
const signalTranscriber = readFileSync(new URL("../../infra/signal-seat/signal-transcriber", import.meta.url), "utf8");
const publishWorkflow = readFileSync(new URL("../../.github/workflows/publish-image.yml", import.meta.url), "utf8");

/** The `environment:` block of the named service, up to the next same-indent key. */
function serviceEnv(service: string): string {
  const start = compose.indexOf(`\n  ${service}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const end = rest.search(/\n {2}\S/);
  const block = end === -1 ? rest : rest.slice(0, end);
  const envStart = block.indexOf("\n    environment:\n");
  expect(envStart).toBeGreaterThan(-1);
  const envRest = block.slice(envStart + 1);
  const envEnd = envRest.search(/\n {4}\S/);
  return envEnd === -1 ? envRest : envRest.slice(0, envEnd);
}

/** Exact (trimmed) lines, so a value cannot pass by being a prefix of a longer list. */
const lines = (block: string) => block.split("\n").map((line) => line.trim());

function serviceImage(service: string): string {
  const start = compose.indexOf(`\n  ${service}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const end = rest.search(/\n {2}\S/);
  const block = end === -1 ? rest : rest.slice(0, end);
  const image = block.match(/^ {4}image: (.+)$/m)?.[1];
  expect(image).toBeDefined();
  const defaultImage = image?.match(/^\$\{[^:}]+:-(.+)\}$/)?.[1] ?? image;
  return defaultImage ?? "";
}

describe("infra/dstack/app-compose.yaml", () => {
  test("renders as an image-only deployment with no local build contexts", () => {
    const rendered = Bun.spawnSync(
      ["docker", "compose", "-f", "infra/dstack/app-compose.yaml", "--env-file", "infra/dstack/.env.example", "config", "--format", "json"],
      { cwd: repo, stdout: "pipe", stderr: "pipe" },
    );
    expect(rendered.exitCode).toBe(0);
    const services = Object.values(JSON.parse(rendered.stdout.toString()).services) as Array<Record<string, unknown>>;
    expect(services.length).toBe(19);
    for (const service of services) {
      expect(service.build).toBeUndefined();
      expect(service.image).toBeString();
      expect(service.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
    expect(compose).not.toMatch(/^\s+build:/m);
    expect(compose).not.toMatch(/^\s+context:/m);
    expect(compose).not.toMatch(/^\s+dockerfile:/m);
  });

  test("pins public pullable MinIO server and client releases by digest", () => {
    const serverImage = compose.match(/\n  minio:\n    image: ([^\n]+)/)?.[1];
    const clientImage = compose.match(/\n  minio-init:\n    image: ([^\n]+)/)?.[1];

    expect(serverImage).toBe(
      "quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e",
    );
    expect(clientImage).toBe(
      "quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727",
    );
    expect(compose).not.toMatch(/image:\s+minio\/(?:minio|mc):/);
    expect(compose).not.toMatch(/image:\s+quay\.io\/minio\/(?:minio|mc):latest/);
  });

  test("pins every deploy and runtime-pulled image to an approved immutable digest", () => {
    const expected = {
      api: "ghcr.io/tinycloudlabs/tinycloud-private-transcription/api:b8d3aed474aec3869f89c0745a1e7683a4d62726@sha256:4df3cedb18e35070b8fc3666ff54b6abbcf49b9ea36864acc7f7899ebc30f9a8",
      worker: "ghcr.io/tinycloudlabs/tinycloud-private-transcription/api:b8d3aed474aec3869f89c0745a1e7683a4d62726@sha256:4df3cedb18e35070b8fc3666ff54b6abbcf49b9ea36864acc7f7899ebc30f9a8",
      "signal-capture": "ghcr.io/tinycloudlabs/tinycloud-private-transcription/signal-seat:c3cdff63e429720a79903384509337f3e67caf3d@sha256:1ebac9dc13cf868131abf9a1719b3a3a268058cae59e228bcddc75e51c57cf4f",
      "signal-control-provision": "curlimages/curl:8.10.1@sha256:d9b4541e214bcd85196d6e92e2753ac6d0ea699f0af5741f8c6cccbfcf00ef4b",
      "signal-capability-provision": "curlimages/curl:8.10.1@sha256:d9b4541e214bcd85196d6e92e2753ac6d0ea699f0af5741f8c6cccbfcf00ef4b",
      postgres: "postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685",
      redis: "redis:7-alpine@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf",
      "vexa-redis": "valkey/valkey:8-alpine@sha256:d2e18f3410b6f616de1417f570fa55261af2898b9c5b2cfb6781ce2373ea43d1",
      "vexa-postgres": "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73",
      minio: "quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e",
      "minio-init": "quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727",
      "admin-api": "vexaai/v012-admin-api:v012@sha256:4c702354384eafe3a933cd537a106b7c15067cfd368a5f6da1a6e675e7e03e04",
      "bot-image-keeper": "ghcr.io/tinycloudlabs/vexa/bot:tc-e5b5307@sha256:32404172d0c843d29ec2617df52d8ca9cb09d510f6423e6aa355aac859196253",
      "bot-janitor": "docker:27.5.1-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c",
      runtime: "vexaai/v012-runtime:v012@sha256:a1f6448fbb380b9433364e8b572ec25a12aa4f274bf403f1d83a89cbf5812f2d",
      whisper: "fedirz/faster-whisper-server:latest-cpu@sha256:760e5e43d427dc6cfbbc4731934b908b7de9c7e6d5309c6a1f0c8c923a5b6030",
      "meeting-api": "ghcr.io/tinycloudlabs/vexa/meeting-api:tc-c8d7f33@sha256:944c2c36d1ba8617d1c49eae5453750a14db2587ba53f40533f8bcfdcfa37566",
      gateway: "ghcr.io/tinycloudlabs/vexa/gateway:tc-36f0304@sha256:0e82c34a3f5838d6f592c71d6e8bebe4e79d3d0414160261def07a57971ef238",
      "vexa-provision": "curlimages/curl:8.10.1@sha256:d9b4541e214bcd85196d6e92e2753ac6d0ea699f0af5741f8c6cccbfcf00ef4b",
    } as const;

    for (const [service, image] of Object.entries(expected)) {
      expect(serviceImage(service)).toBe(image);
      expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    }

    const runtime = serviceEnv("runtime");
    expect(runtime).toContain(
      "BROWSER_IMAGE: ${PTX_BOT_IMAGE:-ghcr.io/tinycloudlabs/vexa/bot:tc-e5b5307@sha256:32404172d0c843d29ec2617df52d8ca9cb09d510f6423e6aa355aac859196253}",
    );
    expect(runtime).toContain(
      "AGENT_IMAGE: ${VEXA_AGENT_IMAGE:-vexaai/v012-agent-api:v012@sha256:6eb37574b33aab233aabbe5907e06e106bae44a403e5df781a436da8201a928d}",
    );
    expect(runtime).toContain(
      "AGENT_WORKER_IMAGE: ${VEXA_AGENT_WORKER_IMAGE:-vexaai/v012-agent-worker:v012@sha256:a1120b24765ff6b1c86c5f9ddee35b5e71fdbb9543a23b918b278373ad705022}",
    );
    expect(compose).not.toContain("VEXA_IMAGE_TAG");

    const imageOverrides = envExample
      .split("\n")
      .filter((line) => /^[A-Z_]+_IMAGE=/.test(line));
    expect(imageOverrides.length).toBe(5);
    for (const line of imageOverrides) expect(line).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(compose).not.toContain("${PTX_IMAGE");
    expect(compose).not.toContain("${SIGNAL_CAPTURE_IMAGE");
    expect(envExample).not.toMatch(/^PTX_IMAGE=/m);
    expect(envExample).not.toMatch(/^SIGNAL_CAPTURE_IMAGE=/m);
  });

  test("pins the Vexa bot, meeting-api, and gateway to the accepted fork commits and digests", () => {
    expect(compose).toContain(
      "ghcr.io/tinycloudlabs/vexa/bot:tc-e5b5307@sha256:32404172d0c843d29ec2617df52d8ca9cb09d510f6423e6aa355aac859196253",
    );
    expect(compose).toContain(
      "ghcr.io/tinycloudlabs/vexa/meeting-api:tc-c8d7f33@sha256:944c2c36d1ba8617d1c49eae5453750a14db2587ba53f40533f8bcfdcfa37566",
    );
    expect(compose).toContain(
      "ghcr.io/tinycloudlabs/vexa/gateway:tc-36f0304@sha256:0e82c34a3f5838d6f592c71d6e8bebe4e79d3d0414160261def07a57971ef238",
    );
    expect(compose).not.toContain("tc-2db950b");
    expect(compose).not.toContain("vexaai/v012-meeting-api");
    expect(compose).not.toContain("vexaai/v012-gateway");
    expect(compose).toContain("vexaai/v012-runtime:v012@sha256:");
    expect(compose).toContain("vexaai/v012-agent-api:v012@sha256:");
  });

  test("the api service enables deployed meeting platforms including Signal", () => {
    const env = serviceEnv("api");
    const line = env.split("\n").find((l) => l.trim().startsWith("ENABLED_PLATFORMS:"));
    expect(line).toBeDefined();
    // Production support must not depend on a mutable or stale deployment override.
    expect(line).not.toContain("${");
    expect(line).toContain("jitsi");
    expect(line).toContain("google_meet");
    expect(line).toContain("signal");
  });

  test("passes sealed bootstrap API keys to the api service only", () => {
    expect(serviceEnv("api")).toContain(`${BOOTSTRAP_KEYS_ENV}: "\${${BOOTSTRAP_KEYS_ENV}:-}"`);
    expect(serviceEnv("worker")).not.toContain(BOOTSTRAP_KEYS_ENV);
    expect(envExample).toMatch(new RegExp(`^${BOOTSTRAP_KEYS_ENV}=$`, "m"));

    // The rendered api environment carries the minted JSON line verbatim, and API boot accepts it.
    const { env } = mintBootstrapKeys([{ id: "tinychat-batch", project: "tinychat", scopes: ["transcriptions:*"] }]);
    const dir = mkdtempSync(join(tmpdir(), "ptx-bootstrap-env-"));
    try {
      const envFile = join(dir, ".env");
      const sealed = envExample.replace(new RegExp(`^${BOOTSTRAP_KEYS_ENV}=$`, "m"), `${BOOTSTRAP_KEYS_ENV}=${env}`);
      writeFileSync(envFile, sealed);
      const render = (file: string) => {
        const rendered = Bun.spawnSync(
          ["docker", "compose", "-f", "infra/dstack/app-compose.yaml", "--env-file", file, "config", "--format", "json"],
          { cwd: repo, stdout: "pipe", stderr: "pipe" },
        );
        expect(rendered.exitCode).toBe(0);
        return JSON.parse(rendered.stdout.toString()).services as Record<string, { environment: Record<string, string> }>;
      };
      const services = render(envFile);
      expect(services.api!.environment[BOOTSTRAP_KEYS_ENV]).toBe(env);
      expect(parseBootstrapKeys(services.api!.environment[BOOTSTRAP_KEYS_ENV]!)).toHaveLength(1);
      expect(services.worker!.environment[BOOTSTRAP_KEYS_ENV]).toBeUndefined();
      // An empty value (the example) renders empty, which the API treats as no bootstrap management.
      expect(render("infra/dstack/.env.example").api!.environment[BOOTSTRAP_KEYS_ENV]).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("enables fail-closed attributed post-meeting transcription for API and worker", () => {
    for (const service of ["api", "worker"]) {
      const env = serviceEnv(service);
      expect(env).toContain('ATTRIBUTED_TRANSCRIPTION_ENABLED: "true"');
      expect(env).toContain("TINFOIL_BASE_URL: ${TINFOIL_BASE_URL:-https://inference.tinfoil.sh}");
      expect(env).toContain("TINFOIL_API_KEY: ${TINFOIL_API_KEY:-}");
      expect(env).toContain("TINFOIL_MODEL: ${TINFOIL_MODEL:-voxtral-small-24b}");
    }
  });

  test("worker transcribes attributed batches with a timestamped model and evaluates internal meetings (TC-740)", () => {
    const env = serviceEnv("worker");
    expect(env).toContain("TINFOIL_ATTRIBUTED_MODEL: ${TINFOIL_ATTRIBUTED_MODEL:-whisper-large-v3-turbo}");
    expect(env).toContain("EVAL_MODELS: ${EVAL_MODELS:-voxtral-small-24b}");
    expect(env).toMatch(/EVAL_TINYCHAT_ADDRESSES: \$\{EVAL_TINYCHAT_ADDRESSES:-(0x[0-9a-f]{40},?)+\}/);
    expect(env).not.toContain("EVAL_ALL_MEETINGS");
  });

  test("worker retries attributed batches and falls back from empty Whisper results (TC-758)", () => {
    const env = serviceEnv("worker");
    expect(env).toContain("TINFOIL_ATTRIBUTED_FALLBACK_MODEL: ${TINFOIL_ATTRIBUTED_FALLBACK_MODEL:-voxtral-small-24b}");
    expect(env).toContain("ATTRIBUTED_RETRY_BACKOFF_MS: ${ATTRIBUTED_RETRY_BACKOFF_MS:-30000,60000,120000,240000,480000}");
  });

  test("captures attributed Google Meet audio without live Vexa transcription", () => {
    const env = serviceEnv("meeting-api");
    expect(env).toContain('TRANSCRIBE_ENABLED: "false"');
    expect(env).toContain('ATTRIBUTED_AUDIO_ENABLED: "true"');
    expect(env).toContain('RECORDING_ENABLED: "true"');
  });

  test("uses API startup liveness rather than worker-owned publication readiness", () => {
    const apiStart = compose.indexOf("\n  api:\n");
    const api = compose.slice(apiStart, compose.indexOf("\n  worker:\n", apiStart));
    expect(api).toContain("/health/live");
    expect(api).not.toContain("127.0.0.1:8080/health').then");
  });

  test("artifact retention and the bot janitor ship in dry-run (TC-904)", () => {
    const worker = serviceEnv("worker");
    expect(worker).toContain("ARTIFACT_RETENTION_MODE: ${ARTIFACT_RETENTION_MODE:-dry-run}");
    expect(worker).toContain("ARTIFACT_RETENTION_KEEP_VEXA_MEETING_IDS: ${ARTIFACT_RETENTION_KEEP_VEXA_MEETING_IDS:-88}");
    expect(worker).toContain("VEXA_MINIO_ENDPOINT: http://minio:9000");
    // Least privilege: a provisioned list+delete-only user, never the MinIO root credentials.
    expect(worker).toContain("VEXA_MINIO_ACCESS_KEY: ptx-retention");
    expect(worker).toContain("VEXA_MINIO_SECRET_KEY_FILE: /run/minio-retention/secret-key");
    expect(worker).not.toContain("MINIO_ROOT");
    const init = compose.slice(compose.indexOf("\n  minio-init:\n"), compose.indexOf("\n  admin-api:\n"));
    const policy = JSON.parse(init.match(/printf '%s' '(\{.*\})'/)![1]!);
    expect(policy.Statement).toEqual([
      { Effect: "Allow", Action: ["s3:ListBucket"], Resource: ["arn:aws:s3:::vexa"] },
      { Effect: "Allow", Action: ["s3:DeleteObject"], Resource: ["arn:aws:s3:::vexa/recordings/*", "arn:aws:s3:::vexa/attributed-audio/*", "arn:aws:s3:::vexa/signal/*"] },
    ]);
    expect(init).toContain("- minio-retention:/run/minio-retention");
    // The secret goes to mc on stdin, never as an argument visible to ps (TC-938).
    expect(init).toContain(`mc admin user add local ptx-retention < "$$K" >/dev/null`);
    expect(init).not.toMatch(/mc admin user add[^\n]*\$\$\(cat/);
    // The root keys reach `mc alias set` on stdin too; the root password is never an mc argument.
    expect(init).toContain(`printf '%s\\n%s\\n' "$$MINIO_ROOT_USER" "$$MINIO_ROOT_PASSWORD" | mc alias set local http://minio:9000`);
    expect(init).not.toMatch(/mc [^\n|]*MINIO_ROOT_PASSWORD/);
    const janitor = serviceEnv("bot-janitor");
    expect(janitor).toContain("BOT_JANITOR_MODE: ${BOT_JANITOR_MODE:-dry-run}");
    // Must name the same pinned bot image as the runtime, or it could treat the live pin as superseded.
    expect(janitor).toContain(`BOT_IMAGE: ${serviceEnv("runtime").match(/BROWSER_IMAGE: (\S+)/)![1]}`);
  });

  test("the worker gives every Vexa meeting the TinyCloud empty-room window", () => {
    const env = serviceEnv("worker");
    const line = env.split("\n").find((l) => l.trim().startsWith("VEXA_MAX_TIME_LEFT_ALONE_MS:"));
    expect(line).toContain("300000");
  });

  test("ships one authenticated Signal seat with an isolated CDP namespace (TC-901)", () => {
    const api = serviceEnv("api");
    expect(api).toContain("SIGNAL_MAX_CONCURRENT_CALLS: \"1\"");
    expect(lines(api)).toContain("SIGNAL_HEALTH_PATHS: /run/signal-health-1/health.json");
    const worker = serviceEnv("worker");
    expect(lines(worker)).toContain("SIGNAL_CAPTURE_URLS: http://signal-capture:18076");
    expect(lines(worker)).toContain("SIGNAL_CAPTURE_TOKEN_PATHS: /run/signal-control-1/token");
    expect(worker).toContain("SIGNAL_MAX_CONCURRENT_CALLS: \"1\"");
    const workerStart = compose.indexOf("\n  worker:\n");
    const workerBlock = compose.slice(workerStart, compose.indexOf("\n  signal-capture:\n", workerStart));
    expect(workerBlock).toContain("signal-runtime:/run/signal-capability:ro");
    expect(workerBlock).toContain("signal-control-1:/run/signal-control-1:ro");
    expect(workerBlock).toContain("networks: [ptx, vexa, signal-seat-1]");
    expect(workerBlock).not.toContain("signal-health:");
    // Seats 2 and 3 were never linked; their services, volumes, tokens and networks are gone.
    expect(compose).not.toMatch(/signal-capture-[23]|signal-(profile|health|control)-[23]|signal-seat-[23]/);
    const seats = [
      { service: "signal-capture", capture: "18076", cdp: "9222", vnc: "5900", novnc: "6080", profile: "signal-profile", health: "signal-health", control: "signal-control-1", network: "signal-seat-1" },
    ];
    for (const [index, seat] of seats.entries()) {
      const start = compose.indexOf(`\n  ${seat.service}:\n`);
      const nextService = index + 1 < seats.length ? seats[index + 1].service : "signal-control-provision";
      const capture = compose.slice(start, compose.indexOf(`\n  ${nextService}:\n`, start));
      expect(capture).not.toContain("build:");
      expect(capture).not.toContain("network_mode:");
      expect(capture).toContain("SIGNAL_CAPTURE_BIND: 0.0.0.0");
      expect(capture).toContain(`SIGNAL_CAPTURE_PORT: \"${seat.capture}\"`);
      expect(capture).toContain("SIGNAL_CAPTURE_TOKEN_PATH: /run/signal-control/token");
      expect(capture).toContain(`SIGNAL_CDP_PORT: \"${seat.cdp}\"`);
      expect(capture).toContain(`SIGNAL_VNC_PORT: \"${seat.vnc}\"`);
      expect(capture).toContain(`SIGNAL_NOVNC_PORT: \"${seat.novnc}\"`);
      expect(capture).toContain(`127.0.0.1:${seat.novnc}:${seat.novnc}`);
      expect(capture).toContain("SIGNAL_HEALTH_PATH: /run/signal-health/health.json");
      expect(capture).toContain("SIGNAL_WHISPER_HEALTH_URL: http://whisper:8000/health");
      // The same name as whisper's own model, so Signal and Vexa share one loaded copy.
      expect(capture).toContain("SIGNAL_WHISPER_MODEL: ${WHISPER_MODEL:-Systran/faster-whisper-small.en}");
      expect(capture).toContain(`${seat.profile}:/var/lib/signal`);
      expect(capture).toContain(`${seat.health}:/run/signal-health`);
      expect(capture).toContain(`${seat.control}:/run/signal-control:ro`);
      expect(capture).toContain(`${seat.network}: {}`);
      expect(capture).toContain("vexa: {}");
      expect(capture).not.toContain("gw_priority");
      expect(capture).not.toContain("signal-capability:");
      expect(capture).not.toContain("signal-runtime:");
    }
    expect(seatBoot).toContain("sink_name=ptx_input_sink");
    expect(seatBoot).toContain("master=ptx_input_sink.monitor source_name=ptx_input");
    expect(seatBoot).not.toContain("master=ptx_sink.monitor source_name=ptx_input");
    expect(seatBoot).toContain("mktemp -d /tmp/ptx-signal-runtime");
    expect(seatBoot).toContain('rm -f "/tmp/.X${DISPLAY_NUMBER}-lock" "/tmp/.X11-unix/X${DISPLAY_NUMBER}"');
    expect(seatBoot).toContain("--use-fake-ui-for-media-stream");
    expect(seatBoot).toContain("--use-fake-device-for-media-stream");
    expect(seatBoot).toContain('VNC_PORT="${SIGNAL_VNC_PORT:-5900}"');
    expect(seatBoot).toContain('NOVNC_PORT="${SIGNAL_NOVNC_PORT:-6080}"');
    expect(seatBoot).toContain('CDP_PORT="${SIGNAL_CDP_PORT:-9222}"');
    expect(compose).toContain("signal-capability-provision:");
    expect(compose).toContain("signal-runtime:/run/signal-capability");
    expect(compose).toContain("signal-health:/run/signal-health");
    expect(compose).not.toContain("SIGNAL_CAPABILITY_KEY:");
    expect(signalTranscriber).toContain('"${1:-}" = "--check"');
    expect(signalTranscriber).toContain("SIGNAL_WHISPER_HEALTH_URL");
    expect(signalTranscriber).toContain('model="${SIGNAL_WHISPER_MODEL:-small.en}"');
    expect(signalTranscriber).toContain('ptx-signal-whisper-model-ready');
    expect(signalTranscriber).toContain('-F "model=${model}"');
  });

  test("whisper unloads its model when idle and releases the memory (TC-901)", () => {
    const env = serviceEnv("whisper");
    expect(env).toContain("WHISPER__MODEL: ${WHISPER_MODEL:-Systran/faster-whisper-small.en}");
    expect(env).toContain('WHISPER__TTL: "300"');
    expect(env).not.toContain('WHISPER__TTL: "-1"');
    // Without a fixed mmap threshold glibc keeps ~450 MB of an unloaded model resident.
    expect(env).toContain('MALLOC_MMAP_THRESHOLD_: "1048576"');
  });

  test("caps concurrent meeting bots per deploy and applies the cap to the Vexa user (TC-902)", () => {
    const line = "VEXA_MAX_CONCURRENT_BOTS: ${VEXA_MAX_CONCURRENT_BOTS:-2}";
    expect(serviceEnv("api")).toContain(line);
    expect(serviceEnv("vexa-provision")).toContain(line);
    expect(envExample).toMatch(/^VEXA_MAX_CONCURRENT_BOTS=2$/m);
    const start = compose.indexOf("\n  vexa-provision:\n");
    const provision = compose.slice(start, compose.indexOf("\nvolumes:\n", start));
    // The existing user predates the cap, so every boot updates it in place before the key check.
    const patch = provision.indexOf("-X PATCH \"http://admin-api:8001/admin/users/$$ID\" -d '{\"max_concurrent_bots\":'\"$$N\"'}'");
    expect(patch).toBeGreaterThan(-1);
    expect(patch).toBeLessThan(provision.indexOf("[ -s /run/vexa/api-key ] && {"));
    expect(provision).toContain(`'{"email":"self-host@vexa.ai","max_concurrent_bots":'"$$N"'}'`);
    expect(provision).not.toContain('"max_concurrent_bots":5');

    const dir = mkdtempSync(join(tmpdir(), "ptx-bot-cap-env-"));
    try {
      const envFile = join(dir, ".env");
      writeFileSync(envFile, envExample.replace(/^VEXA_MAX_CONCURRENT_BOTS=2$/m, "VEXA_MAX_CONCURRENT_BOTS=3"));
      const rendered = Bun.spawnSync(
        ["docker", "compose", "-f", "infra/dstack/app-compose.yaml", "--env-file", envFile, "config", "--format", "json"],
        { cwd: repo, stdout: "pipe", stderr: "pipe" },
      );
      expect(rendered.exitCode).toBe(0);
      const services = JSON.parse(rendered.stdout.toString()).services as Record<string, { environment: Record<string, string> }>;
      expect(services.api!.environment.VEXA_MAX_CONCURRENT_BOTS).toBe("3");
      expect(services["vexa-provision"]!.environment.VEXA_MAX_CONCURRENT_BOTS).toBe("3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("publishes and CI-builds the Signal seat image", () => {
    expect(publishWorkflow).toContain("infra/signal-seat/**");
    expect(publishWorkflow).toContain("tinycloud-private-transcription/signal-seat");
    expect(publishWorkflow).toContain("file: infra/signal-seat/Dockerfile");
  });
});
