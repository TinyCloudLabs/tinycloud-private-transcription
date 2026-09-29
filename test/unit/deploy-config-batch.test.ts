/**
 * The batch CVM (infra/dstack-batch) and its manual deploy workflow. The meeting CVM's compose is covered by
 * deploy-config.test.ts and is not referenced here.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { batchConfigFromEnv } from "../../src/uploads/config.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const composeText = read("infra/dstack-batch/app-compose.yaml");
/** The compose without comment lines (the header comment names what the file deliberately omits). */
const composeConfig = composeText.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
const workflowText = read(".github/workflows/deploy-batch.yml");
const publishText = read(".github/workflows/publish-image.yml");
const runbook = read("infra/dstack-batch/README.md");
const envExample = read("infra/dstack-batch/.env.example");

const API_IMAGE = /^ghcr\.io\/tinycloudlabs\/tinycloud-private-transcription\/api:(?:[0-9a-f]{40}|PIN_AFTER_P2_MERGE)@sha256:[0-9a-f]{64}$/;
const POSTGRES = "postgres:16-alpine@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685";

type Service = { image: string; build?: unknown; command?: string[]; environment: Record<string, string>; volumes?: { source?: string; target: string }[]; ports?: unknown[] };

function render(): Record<string, Service> {
  const rendered = Bun.spawnSync(
    ["docker", "compose", "-f", "infra/dstack-batch/app-compose.yaml", "--env-file", "infra/dstack-batch/.env.example", "config", "--format", "json"],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  expect(rendered.exitCode).toBe(0);
  return JSON.parse(rendered.stdout.toString()).services;
}

describe("infra/dstack-batch/app-compose.yaml", () => {
  test("is api + upload-worker + postgres only, image-only, every image digest-pinned", () => {
    const services = render();
    expect(Object.keys(services).sort()).toEqual(["api", "postgres", "upload-worker"]);
    for (const service of Object.values(services)) {
      expect(service.build).toBeUndefined();
      expect(service.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
    expect(services.api!.image).toMatch(API_IMAGE);
    expect(services["upload-worker"]!.image).toBe(services.api!.image);
    expect(services.postgres!.image).toBe(POSTGRES);
    expect(composeText).not.toMatch(/^\s+(build|context|dockerfile):/m);
    // The image cannot be overridden from the sealed env.
    expect(composeText).not.toMatch(/image: \$\{/);
  });

  test("runs the batch role with no meeting workload, docker socket, or fault injection", () => {
    const services = render();
    for (const name of ["api", "upload-worker"] as const) {
      const env = services[name]!.environment;
      expect(env.PTX_ROLE).toBe("batch");
      expect(env.BATCH_UPLOAD_DIR).toBe("/var/lib/ptx-batch/uploads");
      expect(services[name]!.volumes?.map((v) => `${v.source}:${v.target}`)).toContain("ptx-batch-uploads:/var/lib/ptx-batch/uploads");
      for (const key of Object.keys(env)) expect(key).not.toMatch(/^(VEXA|REDIS|SIGNAL|TINFOIL|ATTRIBUTED|ENABLED_PLATFORMS)/);
    }
    expect(services["upload-worker"]!.command).toEqual(["bun", "run", "src/uploads/worker.ts"]);
    expect(services["upload-worker"]!.ports ?? []).toEqual([]);
    expect(services.api!.ports?.length).toBe(1);
    expect(composeConfig).not.toContain("docker.sock");
    expect(composeText).not.toContain("PTX_FAULT_INJECT");
    expect(workflowText).toContain("PTX_FAULT_INJECT must never appear");
  });

  test("takes only POSTGRES_PASSWORD, BATCH_TINFOIL_API_KEY and PTX_BOOTSTRAP_KEYS from the sealed env", () => {
    const sealed = [...new Set([...composeConfig.matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
    expect(sealed).toEqual(["BATCH_TINFOIL_API_KEY", "POSTGRES_PASSWORD", "PTX_BOOTSTRAP_KEYS"]);
    expect([...(envExample.match(/^[A-Z0-9_]+(?==)/gm) ?? [])].sort()).toEqual(sealed as string[]);
    const services = render();
    expect(services.api!.environment.PTX_BOOTSTRAP_KEYS).toBe("");
    expect(services["upload-worker"]!.environment.PTX_BOOTSTRAP_KEYS).toBeUndefined();
  });

  test("its literal limits match the code defaults and the upload cap", () => {
    const env = render().api!.environment;
    const defaults = batchConfigFromEnv();
    expect(Number(env.BATCH_MAX_ACTIVE_JOBS)).toBe(defaults.limits.maxActiveJobs);
    expect(Number(env.BATCH_MAX_RESERVED_BYTES)).toBe(defaults.limits.maxReservedBytes);
    expect(Number(env.BATCH_MAX_CONCURRENT_UPLOADS)).toBe(defaults.limits.maxConcurrentUploads);
    expect(Number(env.BATCH_DISK_HIGH_WATER_PERCENT)).toBe(defaults.limits.diskHighWaterPercent);
    expect(Number(env.BATCH_TENANT_DAILY_BYTES)).toBe(defaults.limits.tenantDailyBytes);
    expect(env.BATCH_TINFOIL_MODEL).toBe("voxtral-small-24b");
  });
});

describe(".github/workflows/deploy-batch.yml", () => {
  const workflow = Bun.YAML.parse(workflowText) as {
    env: Record<string, string>;
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: { deploy: { environment: string; steps: { name?: string; run?: string; if?: string }[] } };
  };
  const steps = workflow.jobs.deploy.steps;
  const index = (name: string) => steps.findIndex((step) => step.name === name);

  test("is manual only and uses the ptx-batch environment with read-only repository access", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.jobs.deploy.environment).toBe("ptx-batch");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflowText).toContain('[ "$GITHUB_REF" = "refs/heads/main" ]');
    expect(workflowText).toContain('[ "$CONFIRM" = "$CVM_NAME" ]');
  });

  test("refuses the placeholder pin and any image not built from main", () => {
    const guard = steps[index("Guard inputs, secrets and the image pin")]!.run!;
    expect(guard).toContain("git merge-base --is-ancestor");
    expect(guard).toContain("docker buildx imagetools inspect");
    expect("ghcr.io/tinycloudlabs/tinycloud-private-transcription/api:PIN_AFTER_P2_MERGE@sha256:" + "0".repeat(64)).not.toMatch(/^ghcr\.io\/tinycloudlabs\/tinycloud-private-transcription\/api:[0-9a-f]{40}@sha256:[0-9a-f]{64}$/);
    expect(guard).toContain("([0-9a-f]{40})@(sha256:[0-9a-f]{64})$");
  });

  test("creates with the production OS and private logs; drains before an update; gates on health; then reopens", () => {
    const deploy = steps[index("Deploy")]!.run!;
    expect(deploy).toContain("--no-dev-os");
    expect(deploy.match(/--no-public-logs/g)?.length).toBe(2);
    expect(deploy).toContain('-t "$INSTANCE_TYPE" --disk-size "$DISK_SIZE"');
    expect(workflowText).toContain("INSTANCE_TYPE: tdx.large");
    expect(workflowText).toContain("DISK_SIZE: 40G");
    const order = ["Resolve the CVM", "Drain admission and wait for zero active jobs", "Deploy", "Sync allowed_envs", "Wait for running and resolve the gateway URL", "Health gate (live, then upload_transcription.ready)", "Open admission"].map(index);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(steps[index("Drain admission and wait for zero active jobs")]!.if).toBe("env.MODE == 'update'");
    expect(steps[index("Health gate (live, then upload_transcription.ready)")]!.run).toContain(".checks.upload_transcription.ready");
  });

  test("the admission filter accepts only three non-negative integer counts", () => {
    const jq = (body: unknown) => Bun.spawnSync(["jq", "-er", workflow.env.ADMISSION_ACTIVE_JQ!], { stdin: Buffer.from(JSON.stringify(body)), stdout: "pipe", stderr: "pipe" });
    const ok = jq({ mode: "drain", active: { awaiting_upload: 1, queued: 2, processing: 0 } });
    expect([ok.exitCode, ok.stdout.toString()]).toEqual([0, "1\t2\t0\n"]);
    for (const malformed of [{}, { active: {} }, { active: null }, { active: { awaiting_upload: null, queued: null, processing: null } },
      { active: { awaiting_upload: "0", queued: 0, processing: 0 } }, { active: { awaiting_upload: -1, queued: 0, processing: 0 } },
      { active: { awaiting_upload: 0.5, queued: 0, processing: 0 } }, { active: { queued: 0, processing: 0 } }]) {
      expect({ malformed, exit: jq(malformed).exitCode === 0 }).toEqual({ malformed, exit: false });
    }
  });

  // Runs the real drain step under bash with a fake curl: a malformed 200 must fail closed, never "drained".
  function runDrain(putBody: string, getBodies: string[], timeoutMinutes = "130") {
    const dir = mkdtempSync(join(tmpdir(), "ptx-drain-"));
    try {
      writeFileSync(join(dir, "gets"), getBodies.join("\n") + "\n");
      writeFileSync(join(dir, "curl"), `#!/usr/bin/env bash
if [[ " $* " == *" -X PUT "* ]]; then printf '%s' '${putBody}'; exit 0; fi
n=$(cat "${dir}/n" 2>/dev/null || echo 0); echo $((n + 1)) > "${dir}/n"
sed -n "$((n + 1))p" "${dir}/gets"
`);
      chmodSync(join(dir, "curl"), 0o755);
      const script = steps[index("Drain admission and wait for zero active jobs")]!.run!;
      const run = Bun.spawnSync(["bash", "-c", script], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, BATCH_URL: "https://batch.test", PTX_BATCH_ADMIN_KEY: "k", DRAIN_TIMEOUT_MINUTES: timeoutMinutes, DRAIN_POLL_SECONDS: "0", ADMISSION_ACTIVE_JQ: workflow.env.ADMISSION_ACTIVE_JQ! },
        stdout: "pipe", stderr: "pipe",
      });
      return { exitCode: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const counts = (a: number, q: number, p: number, mode = "drain") => JSON.stringify({ mode, active: { awaiting_upload: a, queued: q, processing: p }, retention_lag_seconds: 0 });

  test("drain waits for zero active jobs and prints the worst case", () => {
    const run = runDrain(counts(0, 1, 1), [counts(0, 1, 0), counts(0, 0, 0)]);
    expect(run.exitCode).toBe(0);
    expect(run.out).toContain("worst case 480 min");
    expect(run.out).toContain("::warning title=Drain may time out::");
    expect(run.out).toContain("active=0");
  });

  test("drain fails closed on a malformed 200 or a mode other than drain", () => {
    for (const bad of ["{}", '{"active":{}}', '{"mode":"drain","active":{"awaiting_upload":null,"queued":null,"processing":null}}', "not json"]) {
      const run = runDrain(counts(0, 1, 0), [bad]);
      expect({ bad, exitCode: run.exitCode, malformed: run.out.includes("Malformed admission response") }).toEqual({ bad, exitCode: 1, malformed: true });
      expect(run.out).not.toContain("active=0");
    }
    expect(runDrain("{}", [counts(0, 0, 0)]).exitCode).toBe(1);
    expect(runDrain(counts(0, 0, 0, "open"), [counts(0, 0, 0)]).exitCode).toBe(1);
  });

  test("the Postgres password must be URI-safe; the runbook generates hex", () => {
    const check = /\[\[ "\$BATCH_POSTGRES_PASSWORD" =~ (\^\[A-Za-z0-9\._~-\]\{32,\}\$) \]\]/.exec(workflowText);
    expect(check).not.toBeNull();
    const accepts = (value: string) => Bun.spawnSync(["bash", "-c", `[[ "$1" =~ ${check![1]} ]]`, "_", value]).exitCode === 0;
    expect(accepts("a".repeat(64))).toBe(true);
    for (const bad of [`${"a".repeat(40)}/b`, `${"a".repeat(40)}+b`, `${"a".repeat(40)}@b`, `${"a".repeat(40)}:b`, `${"a".repeat(40)}%2F`, "short"]) expect(accepts(bad)).toBe(false);
    expect(runbook).toContain("openssl rand -hex 32");
    expect(runbook).not.toContain("-base64");
  });

  test("never prints a secret", () => {
    for (const name of ["BATCH_TINFOIL_API_KEY", "BATCH_POSTGRES_PASSWORD", "PTX_BOOTSTRAP_KEYS", "PTX_BATCH_ADMIN_KEY", "PHALA_CLOUD_API_KEY"]) {
      expect(workflowText).not.toMatch(new RegExp(`echo[^\\n]*\\$\\{?${name}`));
    }
  });

  test("the runbook documents the production OS and the owner prerequisites", () => {
    for (const phrase of ["--no-dev-os", "phala login", "BATCH_TINFOIL_API_KEY", "$170/month", "Never purge the volumes"]) expect(runbook).toContain(phrase);
  });
});

test("merging batch deploy config builds no image (publish-image paths exclude it)", () => {
  const paths = (Bun.YAML.parse(publishText) as { on: { push: { paths: string[] } } }).on.push.paths;
  for (const path of paths) {
    expect(path.startsWith("infra/dstack-batch")).toBe(false);
    expect(path.includes("deploy-batch")).toBe(false);
  }
});
