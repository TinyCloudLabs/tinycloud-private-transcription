/**
 * The CVM deployment must enable google_meet. The code default for ENABLED_PLATFORMS is
 * "jitsi" (src/config.ts), so a compose file that omits the variable silently ships a
 * jitsi-only API — which is exactly how tinycloud.chat ended up answering
 * 400 unsupported_platform ("The google_meet platform was detected but is not enabled on
 * this deployment.") for every valid https://meet.google.com/<code>.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
    expect(services.length).toBe(17);
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
      api: "ghcr.io/tinycloudlabs/tinycloud-private-transcription/api:95bb670701c74828b26abfcd933be4957f31278c@sha256:888a794c43d41e779f9a092b8ccb463c21647213a8eaab3e486b414d2414f2fc",
      worker: "ghcr.io/tinycloudlabs/tinycloud-private-transcription/api:95bb670701c74828b26abfcd933be4957f31278c@sha256:888a794c43d41e779f9a092b8ccb463c21647213a8eaab3e486b414d2414f2fc",
      "signal-capture": "ghcr.io/tinycloudlabs/tinycloud-private-transcription/signal-seat:95bb670701c74828b26abfcd933be4957f31278c@sha256:50fc3f1e1e82dba3a42a2d40182bb96b8c2ee499f62657ecd8353d41a968d97e",
      "signal-capability-provision": "curlimages/curl:8.10.1@sha256:d9b4541e214bcd85196d6e92e2753ac6d0ea699f0af5741f8c6cccbfcf00ef4b",
      postgres: "postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685",
      redis: "redis:7-alpine@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf",
      "vexa-redis": "valkey/valkey:8-alpine@sha256:d2e18f3410b6f616de1417f570fa55261af2898b9c5b2cfb6781ce2373ea43d1",
      "vexa-postgres": "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73",
      minio: "quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e",
      "minio-init": "quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z@sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727",
      "admin-api": "vexaai/v012-admin-api:v012@sha256:4c702354384eafe3a933cd537a106b7c15067cfd368a5f6da1a6e675e7e03e04",
      "bot-image-keeper": "ghcr.io/tinycloudlabs/vexa/bot:tc-a8e0d75@sha256:1422bd5113d01df606b3171bd236042685c04ed7f681f69cd9afeba010df4dc7",
      runtime: "vexaai/v012-runtime:v012@sha256:a1f6448fbb380b9433364e8b572ec25a12aa4f274bf403f1d83a89cbf5812f2d",
      whisper: "fedirz/faster-whisper-server:latest-cpu@sha256:760e5e43d427dc6cfbbc4731934b908b7de9c7e6d5309c6a1f0c8c923a5b6030",
      "meeting-api": "ghcr.io/tinycloudlabs/vexa/meeting-api:tc-e49f3f3@sha256:8cedc5943d943bee0dcb42a1be0478225b4ce9f4e9e6c53cd7a10507a2f794d3",
      gateway: "ghcr.io/tinycloudlabs/vexa/gateway:tc-e49f3f3@sha256:01d9ecd1f126eb8e7943017bfff1e5fb6329c37ced46924925e73bb90630756d",
      "vexa-provision": "curlimages/curl:8.10.1@sha256:d9b4541e214bcd85196d6e92e2753ac6d0ea699f0af5741f8c6cccbfcf00ef4b",
    } as const;

    for (const [service, image] of Object.entries(expected)) {
      expect(serviceImage(service)).toBe(image);
      expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    }

    const runtime = serviceEnv("runtime");
    expect(runtime).toContain(
      "BROWSER_IMAGE: ${PTX_BOT_IMAGE:-ghcr.io/tinycloudlabs/vexa/bot:tc-a8e0d75@sha256:1422bd5113d01df606b3171bd236042685c04ed7f681f69cd9afeba010df4dc7}",
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
      "ghcr.io/tinycloudlabs/vexa/bot:tc-a8e0d75@sha256:1422bd5113d01df606b3171bd236042685c04ed7f681f69cd9afeba010df4dc7",
    );
    expect(compose).toContain(
      "ghcr.io/tinycloudlabs/vexa/meeting-api:tc-e49f3f3@sha256:8cedc5943d943bee0dcb42a1be0478225b4ce9f4e9e6c53cd7a10507a2f794d3",
    );
    expect(compose).toContain(
      "ghcr.io/tinycloudlabs/vexa/gateway:tc-e49f3f3@sha256:01d9ecd1f126eb8e7943017bfff1e5fb6329c37ced46924925e73bb90630756d",
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

  test("the worker gives every Vexa meeting the TinyCloud empty-room window", () => {
    const env = serviceEnv("worker");
    const line = env.split("\n").find((l) => l.trim().startsWith("VEXA_MAX_TIME_LEFT_ALONE_MS:"));
    expect(line).toContain("300000");
  });

  test("ships one loopback-only Signal seat in the worker network namespace", () => {
    const worker = serviceEnv("worker");
    expect(worker).toContain("SIGNAL_CAPTURE_URL: http://127.0.0.1:18076");
    expect(worker).toContain("SIGNAL_MAX_CONCURRENT_CALLS: \"1\"");
    const workerStart = compose.indexOf("\n  worker:\n");
    const workerBlock = compose.slice(workerStart, compose.indexOf("\n  signal-capture:\n", workerStart));
    expect(workerBlock).toContain("127.0.0.1:6080:6080");
    expect(workerBlock).toContain("signal-runtime:/run/signal-capability:ro");
    expect(workerBlock).not.toContain("signal-health:");
    const captureStart = compose.indexOf("\n  signal-capture:\n");
    const capture = compose.slice(captureStart, compose.indexOf("\n  signal-capability-provision:\n", captureStart));
    expect(capture).not.toContain("build:");
    expect(capture).toContain('network_mode: "service:worker"');
    expect(capture).toContain("SIGNAL_CAPTURE_BIND: 127.0.0.1");
    expect(capture).toContain("SIGNAL_HEALTH_PATH: /run/signal-health/health.json");
    expect(capture).toContain("SIGNAL_WHISPER_HEALTH_URL: http://whisper:8000/health");
    expect(capture).toContain("signal-health:/run/signal-health");
    expect(capture).not.toContain("signal-capability:");
    expect(capture).not.toContain("signal-runtime:");
    expect(capture).not.toContain("ports:");
    expect(seatBoot).toContain("sink_name=ptx_input_sink");
    expect(seatBoot).toContain("master=ptx_input_sink.monitor source_name=ptx_input");
    expect(seatBoot).not.toContain("master=ptx_sink.monitor source_name=ptx_input");
    expect(seatBoot).toContain("mktemp -d /tmp/ptx-signal-runtime");
    expect(seatBoot).toContain('rm -f "/tmp/.X${DISPLAY_NUMBER}-lock" "/tmp/.X11-unix/X${DISPLAY_NUMBER}"');
    expect(compose).toContain("signal-capability-provision:");
    expect(compose).toContain("signal-runtime:/run/signal-capability");
    expect(compose).toContain("signal-health:/run/signal-health");
    expect(compose).not.toContain("SIGNAL_CAPABILITY_KEY:");
    expect(signalTranscriber).toContain('"${1:-}" = "--check"');
    expect(signalTranscriber).toContain("SIGNAL_WHISPER_HEALTH_URL");
  });

  test("publishes and CI-builds the Signal seat image", () => {
    expect(publishWorkflow).toContain("infra/signal-seat/**");
    expect(publishWorkflow).toContain("tinycloud-private-transcription/signal-seat");
    expect(publishWorkflow).toContain("file: infra/signal-seat/Dockerfile");
  });
});
