/**
 * The CVM deployment must enable google_meet. The code default for ENABLED_PLATFORMS is
 * "jitsi" (src/config.ts), so a compose file that omits the variable silently ships a
 * jitsi-only API — which is exactly how tinycloud.chat ended up answering
 * 400 unsupported_platform ("The google_meet platform was detected but is not enabled on
 * this deployment.") for every valid https://meet.google.com/<code>.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const compose = readFileSync(new URL("../../infra/dstack/app-compose.yaml", import.meta.url), "utf8");
const seatBoot = readFileSync(new URL("../../infra/signal-seat/boot.sh", import.meta.url), "utf8");
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

describe("infra/dstack/app-compose.yaml", () => {
  test("the api service enables deployed meeting platforms including Signal", () => {
    const env = serviceEnv("api");
    const line = env.split("\n").find((l) => l.trim().startsWith("ENABLED_PLATFORMS:"));
    expect(line).toBeDefined();
    // Whatever the operator override is, the baked-in default must cover both.
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
    const captureStart = compose.indexOf("\n  signal-capture:\n");
    const capture = compose.slice(captureStart, compose.indexOf("\n  postgres:\n", captureStart));
    expect(capture).toContain("context: ../..");
    expect(capture).toContain("dockerfile: infra/signal-seat/Dockerfile");
    expect(capture).toContain('network_mode: "service:worker"');
    expect(capture).toContain("SIGNAL_CAPTURE_BIND: 127.0.0.1");
    expect(capture).not.toContain("ports:");
    expect(seatBoot).toContain("sink_name=ptx_input_sink");
    expect(seatBoot).toContain("master=ptx_input_sink.monitor source_name=ptx_input");
    expect(seatBoot).not.toContain("master=ptx_sink.monitor source_name=ptx_input");
  });

  test("publishes and CI-builds the Signal seat image", () => {
    expect(publishWorkflow).toContain("infra/signal-seat/**");
    expect(publishWorkflow).toContain("tinycloud-private-transcription/signal-seat");
    expect(publishWorkflow).toContain("file: infra/signal-seat/Dockerfile");
  });
});
