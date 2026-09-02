/**
 * The CVM deployment must enable google_meet. The code default for ENABLED_PLATFORMS is
 * "jitsi" (src/config.ts), so a compose file that omits the variable silently ships a
 * jitsi-only API — which is exactly how tinycloud.chat ended up answering
 * 400 unsupported_platform ("The google_meet platform was detected but is not enabled on
 * this deployment.") for every valid https://meet.google.com/<code>.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  RECOVERY_DEPLOYMENT_ENV_FIELDS,
  RECOVERY_ENV_FIELDS,
  recoveryImageReferenceIsImmutable,
} from "../../src/recovery-config.ts";

const compose = readFileSync(new URL("../../infra/dstack/app-compose.yaml", import.meta.url), "utf8");
const rootExample = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
const dstackExample = readFileSync(new URL("../../infra/dstack/.env.example", import.meta.url), "utf8");
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

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
  test("the api service enables google_meet alongside jitsi", () => {
    const env = serviceEnv("api");
    const line = env.split("\n").find((l) => l.trim().startsWith("ENABLED_PLATFORMS:"));
    expect(line).toBeDefined();
    // Whatever the operator override is, the baked-in default must cover both.
    expect(line).toContain("jitsi");
    expect(line).toContain("google_meet");
  });

  test("the worker gives every Vexa meeting the TinyCloud empty-room window", () => {
    const env = serviceEnv("worker");
    const line = env.split("\n").find((l) => l.trim().startsWith("VEXA_MAX_TIME_LEFT_ALONE_MS:"));
    expect(line).toContain("300000");
  });

  test("the complete authoritative deployment registry stays in root/dstack examples and both service environments", () => {
    const api = serviceEnv("api");
    const worker = serviceEnv("worker");
    expect(RECOVERY_DEPLOYMENT_ENV_FIELDS.filter((field) => field === "PTX_IMAGE")).toHaveLength(1);
    for (const field of RECOVERY_DEPLOYMENT_ENV_FIELDS) {
      expect(rootExample, `root example: ${field}`).toMatch(new RegExp(`^${field}=`, "m"));
      expect(dstackExample, `dstack example: ${field}`).toMatch(new RegExp(`^${field}=`, "m"));
      expect(api, `api compose: ${field}`).toMatch(new RegExp(`^\\s+${field}:`, "m"));
      expect(worker, `worker compose: ${field}`).toMatch(new RegExp(`^\\s+${field}:`, "m"));
      expect(readme, `README: ${field}`).toContain(`\`${field}\``);
    }
  });

  test("checked-in recovery switches are default-off and unresolved values remain blank", () => {
    for (const field of [
      "RECOVERY_V2_ENABLED",
      "RECOVERY_PROVIDER_ENABLED",
      "RECOVERY_FINALIZER_ENABLED",
      "RECOVERY_VEXA_FALLBACK_ENABLED",
    ]) {
      expect(rootExample).toMatch(new RegExp(`^${field}=false$`, "m"));
      expect(dstackExample).toMatch(new RegExp(`^${field}=false$`, "m"));
      for (const service of ["api", "worker"]) {
        const environment = serviceEnv(service);
        expect(environment).toContain(`${field}: \${${field}-false}`);
        expect(environment).not.toContain(`${field}: \${${field}:-false}`);
      }
    }
    for (const field of RECOVERY_ENV_FIELDS.filter((name) => !name.endsWith("_ENABLED"))) {
      expect(rootExample).toMatch(new RegExp(`^${field}=$`, "m"));
      expect(dstackExample).toMatch(new RegExp(`^${field}=$`, "m"));
    }
  });

  test("legacy recovery-off deployment defaults remain while recovery rollout requires an immutable image", () => {
    const rootImage = rootExample.match(/^PTX_IMAGE=(.*)$/m)?.[1];
    const exampleImage = dstackExample.match(/^PTX_IMAGE=(.*)$/m)?.[1];
    const legacyImage = "ghcr.io/tinycloudlabs/tinycloud-private-transcription/api:v1";
    const legacyExpression = "${PTX_IMAGE:-" + legacyImage + "}";
    expect(rootImage).toBe("");
    expect(exampleImage).toBe(legacyImage);
    expect(recoveryImageReferenceIsImmutable("registry.invalid/image:v1")).toBe(false);
    expect(compose.split(`image: ${legacyExpression}`).length - 1).toBe(2);
    expect(serviceEnv("api")).toContain(`PTX_IMAGE: \${PTX_IMAGE:-${legacyImage}}`);
    expect(serviceEnv("worker")).toContain(`PTX_IMAGE: \${PTX_IMAGE:-${legacyImage}}`);
    expect(readme).toContain("@sha256:<64 lowercase hex>");
    expect(readme).toMatch(/Legacy recovery-off fallback[\s\S]*ttl\.sh/);
    expect(readme).toMatch(/ttl\.sh[\s\S]*every recovery switch off/);
    expect(readme).toMatch(/delete or omit every blank\s+`RECOVERY_\*` entry/);
  });
});
