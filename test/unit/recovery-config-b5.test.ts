import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  RECOVERY_DEPLOYMENT_ENV_FIELDS,
  RECOVERY_ENV_FIELDS,
  createRecoveryConfiguration,
  recoveryImageReferenceIsImmutable,
} from "../../src/recovery-config.ts";
import { recoveryAcceptancePolicyIsReady } from "../../src/services/recovery.ts";
import { recoveryOperationalReadinessIsReady } from "../../src/services/recovery-readiness.ts";
import { createProductionRecoveryReadinessSource } from "../../src/services/recovery-readiness.ts";
import { UNSET_RECOVERY_OPERATIONAL_READINESS } from "../../src/services/recovery-readiness.ts";
import { startProductionCapabilityHeartbeat } from "../../src/services/recovery-capability.ts";
import { durableDeliveryMaintenanceIsReady } from "../../src/worker/outbox.ts";
import { durableFinalizerPolicyIsReady } from "../../src/worker/recovery-finalizer.ts";
import { readProductionDurableDeliveryPolicy } from "../../src/worker/recovery-runtime.ts";

const DIGEST_IMAGE = `registry.invalid/private-transcription@sha256:${"a".repeat(64)}`;

const FULL_ENV: Record<string, string> = {
  PTX_IMAGE: DIGEST_IMAGE,
  RECOVERY_V2_ENABLED: "true",
  RECOVERY_PROVIDER_ENABLED: "true",
  RECOVERY_FINALIZER_ENABLED: "true",
  RECOVERY_VEXA_FALLBACK_ENABLED: "false",
  RECOVERY_SEGMENTATION_MODE: "speaker_aware",
  RECOVERY_MANUAL_CYCLES_PER_MEETING: "1",
  RECOVERY_COOLDOWN_BASE_MS: "60000",
  RECOVERY_COOLDOWN_MAX_MS: "300000",
  RECOVERY_MAX_SOURCE_DURATION_MS: "600000",
  RECOVERY_MAX_SOURCE_PCM_BYTES: "20000000",
  RECOVERY_MAX_RECORDING_BYTES: "10000000",
  RECOVERY_PROVIDER_MAX_CHUNK_DURATION_MS: "300001",
  RECOVERY_PROVIDER_MAX_WAV_BYTES: "5000001",
  RECOVERY_MAX_CHUNK_DURATION_MS: "300000",
  RECOVERY_MAX_WAV_BYTES: "5000000",
  RECOVERY_MAX_CALLS_PER_OPERATION: "20",
  RECOVERY_MAX_SUBMITTED_AUDIO_MS_PER_OPERATION: "1200000",
  RECOVERY_MAX_COST_MICROUNITS_PER_OPERATION: "100000",
  RECOVERY_MAX_CONCURRENT_PROVIDER_CALLS: "1",
  RECOVERY_OPERATION_DEADLINE_MS: "2700000",
  RECOVERY_DELAYED_THRESHOLD_MS: "900000",
  RECOVERY_SPLIT_FLOOR_MS: "60000",
  RECOVERY_RETRY_BASE_MS: "1000",
  RECOVERY_MAX_RETRY_AFTER_MS: "30000",
  RECOVERY_PROJECT_MANUAL_CYCLES: "5",
  RECOVERY_PROJECT_AUTOMATIC_CYCLES: "0",
  RECOVERY_PROJECT_MAX_CALLS: "100",
  RECOVERY_PROJECT_MAX_SUBMITTED_AUDIO_MS: "6000000",
  RECOVERY_PROJECT_MAX_COST_MICROUNITS: "500000",
  RECOVERY_PLAN_MAX_CHUNKS: "20",
  RECOVERY_PLAN_MAX_CANDIDATES: "10000",
  RECOVERY_PLAN_QUIET_SEARCH_MS: "200",
  RECOVERY_PLAN_QUIET_WINDOW_MS: "20",
  RECOVERY_PLAN_SILENCE_THRESHOLD_DBFS: "-60",
  RECOVERY_RECORDING_MAX_MEDIA_FILES: "4",
  RECOVERY_RECORDING_MAX_METADATA_STRING_LENGTH: "64",
  RECOVERY_RECORDING_ALLOWED_MEDIA_TYPES: "audio/webm,audio/wav",
  RECOVERY_RECORDING_MAX_DURATION_MS: "600000",
  RECOVERY_RECORDING_MAX_BYTES: "9000000",
  RECOVERY_DELIVERY_LEASE_MS: "60000",
  RECOVERY_DELIVERY_MAX_ATTEMPTS: "3",
  RECOVERY_DELIVERY_MAX_AGE_MS: "2400000",
  RECOVERY_DELIVERY_RETRY_DELAY_MS: "1000",
  RECOVERY_DELIVERY_IDLE_MS: "500",
  RECOVERY_CAPABILITY_LEASE_MS: "60000",
  RECOVERY_CAPABILITY_HEARTBEAT_MS: "10000",
  RECOVERY_RETENTION_POLICY_VERSION: "retention-reviewed-v1",
  RECOVERY_PRICE_VERSION: "price-reviewed-v1",
  RECOVERY_API_BUILD_REVISION: "api-build-v1",
  RECOVERY_WORKER_BUILD_REVISION: "worker-build-v1",
  RECOVERY_API_CONTRACT_VERSION: "recovery-v2",
  RECOVERY_WORKER_CONTRACT_VERSION: "recovery-v2",
  RECOVERY_FINALIZER_VERSION: "finalizer-v2",
  RECOVERY_SCHEMA_VERSION: "0003",
};

function changed(name: string, value: string): Record<string, string> {
  return { ...FULL_ENV, [name]: value };
}

function assertDeepFrozen(value: unknown, seen = new Set<unknown>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

describe("B5 authoritative fail-closed recovery configuration", () => {
  test("an absent or partial configuration starts dark without invented values", () => {
    const dark = createRecoveryConfiguration({});
    expect(dark.switches).toEqual({
      acceptance: false,
      providerV2Dispatch: false,
      durableFinalizer: false,
      vexaFallback: false,
    });
    expect(dark.acceptancePolicy.enabled).toBe(false);
    expect(dark.acceptancePolicy.recording).toBeNull();
    expect(dark.plannerLimits).toBeNull();
    expect(dark.finalizerPolicy).toBeNull();
    expect(dark.capabilityTimings).toEqual({ leaseMs: null, heartbeatMs: null });
    expect(Object.values(dark.snapshot.readiness).every((ready) => ready === false)).toBe(true);
    expect(recoveryOperationalReadinessIsReady(dark.operationalReadiness)).toBe(false);

    const partial = createRecoveryConfiguration({ RECOVERY_MAX_SOURCE_DURATION_MS: "600000" });
    expect(partial.acceptancePolicy.providerLimits.maxSourceDurationMs).toBe(600_000);
    expect(partial.acceptancePolicy.providerLimits.maxRecordingBytes).toBeNull();
    expect(partial.snapshot.readiness.acceptancePolicy).toBe(false);
  });

  test("each intent switch is strict, defaults off, and never implies another", () => {
    const switches = [
      ["RECOVERY_V2_ENABLED", "acceptance"],
      ["RECOVERY_PROVIDER_ENABLED", "providerV2Dispatch"],
      ["RECOVERY_FINALIZER_ENABLED", "durableFinalizer"],
      ["RECOVERY_VEXA_FALLBACK_ENABLED", "vexaFallback"],
    ] as const;
    for (const [field, property] of switches) {
      const enabled = createRecoveryConfiguration({ [field]: "true" });
      expect(enabled.switches[property]).toBe(true);
      expect(Object.entries(enabled.switches).filter(([name]) => name !== property).every(([, value]) => value === false)).toBe(true);
      expect(createRecoveryConfiguration({ [field]: "false" }).switches[property]).toBe(false);
      for (const invalid of ["TRUE", "False", "1", "yes", "", " true"] ) {
        expect(() => createRecoveryConfiguration({ [field]: invalid })).toThrow(field);
      }
    }
    expect(createRecoveryConfiguration({ TRANSCRIPTION_PROVIDER: "tinfoil", TINFOIL_SEGMENTATION: "turns" }).switches)
      .toEqual({ acceptance: false, providerV2Dispatch: false, durableFinalizer: false, vexaFallback: false });
  });

  test("integer fields reject permissive Number syntax and unsafe or overflowing values", () => {
    for (const value of ["1e3", " 1", "1 ", "+1", "-1", "1.5", "NaN", "Infinity", "", "9007199254740992"] ) {
      expect(() => createRecoveryConfiguration({ RECOVERY_MAX_SOURCE_DURATION_MS: value })).toThrow("RECOVERY_MAX_SOURCE_DURATION_MS");
    }
    for (const value of ["0", "-1", "2147483648"]) {
      expect(() => createRecoveryConfiguration({ RECOVERY_DELIVERY_LEASE_MS: value })).toThrow("RECOVERY_DELIVERY_LEASE_MS");
    }
    expect(() => createRecoveryConfiguration({ RECOVERY_PROJECT_MAX_COST_MICROUNITS: "9223372036854775808" }))
      .toThrow("RECOVERY_PROJECT_MAX_COST_MICROUNITS");
    const numericFields = RECOVERY_ENV_FIELDS.filter((field) =>
      field !== "RECOVERY_V2_ENABLED"
      && field !== "RECOVERY_PROVIDER_ENABLED"
      && field !== "RECOVERY_FINALIZER_ENABLED"
      && field !== "RECOVERY_VEXA_FALLBACK_ENABLED"
      && field !== "RECOVERY_SEGMENTATION_MODE"
      && field !== "RECOVERY_RECORDING_ALLOWED_MEDIA_TYPES"
      && !field.endsWith("_VERSION")
      && !field.endsWith("_REVISION"));
    for (const field of numericFields) {
      expect(() => createRecoveryConfiguration({ [field]: "1e3" }), field).toThrow(field);
    }
  });

  test("versions, segmentation, and media lists are bounded and canonical", () => {
    for (const value of ["", " ", "bad/value", "v".repeat(129)]) {
      expect(() => createRecoveryConfiguration({ RECOVERY_RETENTION_POLICY_VERSION: value })).toThrow("RECOVERY_RETENTION_POLICY_VERSION");
    }
    for (const value of ["", "turns", "whole", "speaker-aware"] ) {
      expect(() => createRecoveryConfiguration({ RECOVERY_SEGMENTATION_MODE: value })).toThrow("RECOVERY_SEGMENTATION_MODE");
    }
    for (const value of ["", "audio/webm,", ",audio/webm", "audio/webm,audio/webm", "video/mp4", "audio/WebM", "audio/webm, audio/wav"] ) {
      expect(() => createRecoveryConfiguration({
        RECOVERY_RECORDING_MAX_MEDIA_FILES: "4",
        RECOVERY_RECORDING_MAX_METADATA_STRING_LENGTH: "64",
        RECOVERY_RECORDING_ALLOWED_MEDIA_TYPES: value,
      })).toThrow("RECOVERY_RECORDING_ALLOWED_MEDIA_TYPES");
    }
  });

  test("every material cross-field invariant rejects the field that violates it", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["RECOVERY_COOLDOWN_BASE_MS", changed("RECOVERY_COOLDOWN_BASE_MS", "300001")],
      ["RECOVERY_RECORDING_MAX_DURATION_MS", changed("RECOVERY_RECORDING_MAX_DURATION_MS", "600001")],
      ["RECOVERY_RECORDING_MAX_BYTES", changed("RECOVERY_RECORDING_MAX_BYTES", "10000001")],
      ["RECOVERY_MAX_CHUNK_DURATION_MS", changed("RECOVERY_MAX_CHUNK_DURATION_MS", "300001")],
      ["RECOVERY_MAX_WAV_BYTES", changed("RECOVERY_MAX_WAV_BYTES", "5000001")],
      ["RECOVERY_MAX_WAV_BYTES", { ...FULL_ENV, RECOVERY_MAX_WAV_BYTES: "45", RECOVERY_PROVIDER_MAX_WAV_BYTES: "100" }],
      ["RECOVERY_MAX_CALLS_PER_OPERATION", changed("RECOVERY_MAX_CALLS_PER_OPERATION", "101")],
      ["RECOVERY_MAX_SUBMITTED_AUDIO_MS_PER_OPERATION", changed("RECOVERY_MAX_SUBMITTED_AUDIO_MS_PER_OPERATION", "6000001")],
      ["RECOVERY_MAX_COST_MICROUNITS_PER_OPERATION", changed("RECOVERY_MAX_COST_MICROUNITS_PER_OPERATION", "500001")],
      ["RECOVERY_DELAYED_THRESHOLD_MS", changed("RECOVERY_DELAYED_THRESHOLD_MS", "2700000")],
      ["RECOVERY_RETRY_BASE_MS", changed("RECOVERY_RETRY_BASE_MS", "2700001")],
      ["RECOVERY_RETRY_BASE_MS", { ...changed("RECOVERY_RETRY_BASE_MS", "30001") }],
      ["RECOVERY_MAX_RETRY_AFTER_MS", changed("RECOVERY_MAX_RETRY_AFTER_MS", "2700001")],
      ["RECOVERY_DELIVERY_RETRY_DELAY_MS", changed("RECOVERY_DELIVERY_RETRY_DELAY_MS", "2700001")],
      ["RECOVERY_DELIVERY_LEASE_MS", { ...FULL_ENV, RECOVERY_DELIVERY_LEASE_MS: "60001", RECOVERY_DELIVERY_MAX_AGE_MS: "60000" }],
      ["RECOVERY_SPLIT_FLOOR_MS", changed("RECOVERY_SPLIT_FLOOR_MS", "300000")],
      ["RECOVERY_PLAN_QUIET_WINDOW_MS", changed("RECOVERY_PLAN_QUIET_WINDOW_MS", "201")],
      ["RECOVERY_PLAN_QUIET_SEARCH_MS", changed("RECOVERY_PLAN_QUIET_SEARCH_MS", "300000")],
      ["RECOVERY_PLAN_MAX_CANDIDATES", changed("RECOVERY_PLAN_MAX_CANDIDATES", "19")],
      ["RECOVERY_CAPABILITY_HEARTBEAT_MS", changed("RECOVERY_CAPABILITY_HEARTBEAT_MS", "60000")],
      ["RECOVERY_MAX_CONCURRENT_PROVIDER_CALLS", changed("RECOVERY_MAX_CONCURRENT_PROVIDER_CALLS", "21")],
      ["RECOVERY_WORKER_CONTRACT_VERSION", changed("RECOVERY_WORKER_CONTRACT_VERSION", "recovery-v3")],
      ["RECOVERY_PROJECT_AUTOMATIC_CYCLES", changed("RECOVERY_PROJECT_AUTOMATIC_CYCLES", "1")],
      ["RECOVERY_MANUAL_CYCLES_PER_MEETING", changed("RECOVERY_MANUAL_CYCLES_PER_MEETING", "0")],
    ];
    for (const [field, environment] of cases) {
      expect(() => createRecoveryConfiguration(environment), field).toThrow(field);
    }
  });

  test("ready policy permits independent planning, repair, capability, and recording bounds", () => {
    const result = createRecoveryConfiguration({
      ...FULL_ENV,
      RECOVERY_MAX_CALLS_PER_OPERATION: "21",
      RECOVERY_CAPABILITY_LEASE_MS: "3000000",
      RECOVERY_CAPABILITY_HEARTBEAT_MS: "2800000",
      RECOVERY_DELIVERY_MAX_AGE_MS: "3000000",
      RECOVERY_RECORDING_MAX_BYTES: "4000000",
      RECOVERY_RECORDING_MAX_DURATION_MS: "200000",
    }, {
      dispatchAdapterReady: true,
      providerAdapterReady: true,
      recordingAdapterReady: true,
      checkpointProtectionReady: true,
    });

    expect(result.finalizerPolicy?.maxOperationCalls).toBe(21);
    expect(result.plannerLimits?.maxChunks).toBe(20);
    expect(result.capabilityTimings).toEqual({ leaseMs: 3_000_000, heartbeatMs: 2_800_000 });
    expect(result.deliveryPolicy.maxAgeMs).toBe(3_000_000);
    expect(result.recordingPolicy).toMatchObject({ maxBytes: 4_000_000, maxDurationMs: 200_000 });
    expect(recoveryOperationalReadinessIsReady(result.operationalReadiness)).toBe(true);
  });

  test("a fully explicit environment constructs every accepted policy but production evidence remains unavailable", () => {
    const result = createRecoveryConfiguration(FULL_ENV, {
      dispatchAdapterReady: false,
      providerAdapterReady: false,
    });
    expect(recoveryAcceptancePolicyIsReady(result.acceptancePolicy)).toBe(true);
    expect(result.plannerLimits).not.toBeNull();
    expect(result.recordingPolicy).not.toBeNull();
    expect(result.finalizerPolicy).not.toBeNull();
    expect(durableFinalizerPolicyIsReady(result.finalizerPolicy!)).toBe(true);
    expect(durableDeliveryMaintenanceIsReady(result.deliveryPolicy)).toBe(true);
    expect(result.snapshot.readiness).toMatchObject({
      acceptancePolicy: true,
      planner: true,
      finalizerPolicy: true,
      durableDelivery: true,
      capabilityTimings: true,
      immutableImage: true,
      dispatchAdapter: false,
      providerAdapter: false,
      recordingAdapter: false,
      checkpointProtection: false,
      operational: false,
    });
    expect(recoveryOperationalReadinessIsReady(result.operationalReadiness)).toBe(false);
  });

  test("every registered non-fallback value is required before operational readiness", () => {
    const evidence = {
      dispatchAdapterReady: true,
      providerAdapterReady: true,
      recordingAdapterReady: true,
      checkpointProtectionReady: true,
    };
    expect(recoveryOperationalReadinessIsReady(createRecoveryConfiguration(FULL_ENV, evidence).operationalReadiness)).toBe(true);
    for (const field of RECOVERY_ENV_FIELDS) {
      if (field === "RECOVERY_VEXA_FALLBACK_ENABLED") continue;
      const missing = { ...FULL_ENV };
      delete missing[field];
      expect(
        recoveryOperationalReadinessIsReady(createRecoveryConfiguration(missing, evidence).operationalReadiness),
        field,
      ).toBe(false);
    }
  });

  test("the sanitized snapshot and revision are deterministic, immutable, JSON-safe, and secret-independent", () => {
    const a = createRecoveryConfiguration({
      ...FULL_ENV,
      TINFOIL_API_KEY: "SENTINEL_SECRET",
      TINFOIL_BASE_URL: "https://SENTINEL_URL.invalid",
      RECOVERY_UNRELATED_CONTENT: "SENTINEL_CONTENT",
      RECOVERY_MEETING_ID: "SENTINEL_MEETING",
    });
    const reversed = Object.fromEntries(Object.entries(FULL_ENV).reverse());
    const b = createRecoveryConfiguration(reversed);
    expect(a.revision).toBe(b.revision);
    assertDeepFrozen(a.snapshot);
    const serialized = JSON.stringify(a.snapshot);
    expect(() => JSON.parse(serialized)).not.toThrow();
    for (const sentinel of ["SENTINEL_SECRET", "SENTINEL_URL", "SENTINEL_CONTENT", "SENTINEL_MEETING", "TINFOIL_API_KEY", "BASE_URL"] ) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(createRecoveryConfiguration({ ...FULL_ENV, TINFOIL_API_KEY: "changed" }).revision).toBe(a.revision);
    expect((a.snapshot.deployment as { imageDigest: string }).imageDigest).toBe(`sha256:${"a".repeat(64)}`);
    expect(serialized).not.toContain("registry.invalid/private-transcription");
    expect(createRecoveryConfiguration({
      ...FULL_ENV,
      PTX_IMAGE: `another.invalid/other@sha256:${"b".repeat(64)}`,
    }).revision).not.toBe(a.revision);
    expect(createRecoveryConfiguration(changed("RECOVERY_MAX_SOURCE_DURATION_MS", "600001")).revision).not.toBe(a.revision);
    expect(serialized).toContain('"maxCostMicrounits":"100000"');
  });

  test("the field registry is unique, complete, and excludes credentials and URLs", () => {
    expect(new Set(RECOVERY_ENV_FIELDS).size).toBe(RECOVERY_ENV_FIELDS.length);
    expect(new Set(RECOVERY_DEPLOYMENT_ENV_FIELDS).size).toBe(RECOVERY_DEPLOYMENT_ENV_FIELDS.length);
    expect(RECOVERY_DEPLOYMENT_ENV_FIELDS.filter((field) => field === "PTX_IMAGE")).toHaveLength(1);
    expect(RECOVERY_DEPLOYMENT_ENV_FIELDS.filter((field) => field.startsWith("RECOVERY_")))
      .toEqual([...RECOVERY_ENV_FIELDS]);
    for (const field of Object.keys(FULL_ENV).filter((name) => name.startsWith("RECOVERY_"))) {
      expect(RECOVERY_ENV_FIELDS as readonly string[]).toContain(field);
    }
    expect(RECOVERY_ENV_FIELDS.some((name) => /KEY|TOKEN|PASSWORD|SECRET|URL/.test(name))).toBe(false);
  });

  test("recovery rollout image references accept immutable OCI digests only", () => {
    const digest = `@sha256:${"b".repeat(64)}`;
    for (const value of [
      DIGEST_IMAGE,
      `ghcr.io/tinycloudlabs/tinycloud-private-transcription/api${digest}`,
      `localhost:5000/team/image:v1${digest}`,
      `registry:65535/team/sub_repo/image-name.part:Release_1${digest}`,
      `127.0.0.1:5000/image${digest}`,
      `image:v1${digest}`,
    ]) {
      expect(recoveryImageReferenceIsImmutable(value), value).toBe(true);
    }
    for (const value of [
      undefined,
      "",
      "image:v1",
      "image:sha",
      "image@sha256:abc",
      `image@sha256:${"A".repeat(64)}`,
      `https://registry.invalid/image@sha256:${"a".repeat(64)}`,
      `user:password@registry.invalid/image@sha256:${"a".repeat(64)}`,
      `registry.invalid/image@@sha256:${"a".repeat(64)}`,
      `registry.invalid/im age@sha256:${"a".repeat(64)}`,
      `registry.invalid/image\n@sha256:${"a".repeat(64)}`,
      `${"a".repeat(448)}@sha256:${"a".repeat(64)}`,
      `image:v1:v2${digest}`,
      `registry::5000/image${digest}`,
      `registry:abc/image${digest}`,
      `reg_istry/image${digest}`,
      `registry:/image${digest}`,
      `registry:0/image${digest}`,
      `registry:65536/image${digest}`,
      `registry:5000:5001/image${digest}`,
      `.registry.invalid/image${digest}`,
      `registry-.invalid/image${digest}`,
      `registry.invalid//image${digest}`,
      `registry.invalid/image/${digest}`,
      `registry.invalid/.image${digest}`,
      `registry.invalid/image..part${digest}`,
      `registry.invalid/image:${digest}`,
      `registry.invalid/image:${"t".repeat(129)}${digest}`,
    ]) {
      expect(recoveryImageReferenceIsImmutable(value), String(value)).toBe(false);
    }
    expect(() => createRecoveryConfiguration({ ...FULL_ENV, PTX_IMAGE: "registry.invalid/image:v1" })).toThrow("PTX_IMAGE");
    for (const field of [
      "RECOVERY_V2_ENABLED",
      "RECOVERY_PROVIDER_ENABLED",
      "RECOVERY_FINALIZER_ENABLED",
      "RECOVERY_VEXA_FALLBACK_ENABLED",
    ]) {
      expect(() => createRecoveryConfiguration({ [field]: "true", PTX_IMAGE: "registry.invalid/image:v1" })).toThrow("PTX_IMAGE");
    }
    expect(() => createRecoveryConfiguration({ PTX_IMAGE: "registry.invalid/image:v1" })).not.toThrow();
    const legacy = createRecoveryConfiguration({ PTX_IMAGE: "registry.invalid/image:v1" });
    expect((legacy.snapshot.deployment as { imageDigest: string | null }).imageDigest).toBeNull();
    expect(legacy.snapshot.readiness.immutableImage).toBe(false);
    const noImage = { ...FULL_ENV };
    delete noImage.PTX_IMAGE;
    const enabledWithoutProvenance = createRecoveryConfiguration(noImage);
    expect((enabledWithoutProvenance.snapshot.deployment as { imageDigest: string | null }).imageDigest).toBeNull();
    expect(recoveryOperationalReadinessIsReady(enabledWithoutProvenance.operationalReadiness)).toBe(false);
  });

  test("a parsed configuration reevaluates all trusted adapter evidence on every readiness read", () => {
    const configuration = createRecoveryConfiguration(FULL_ENV);
    const reads = { dispatch: 0, provider: 0, recording: 0, checkpoint: 0 };
    const live = {
      dispatch: false,
      provider: false,
      recording: false,
      checkpoint: false,
    };
    const source = createProductionRecoveryReadinessSource(configuration, {
      dispatchAdapterReady: () => (reads.dispatch++, live.dispatch),
      providerAdapterReady: () => (reads.provider++, live.provider),
      recordingAdapterReady: () => (reads.recording++, live.recording),
      checkpointProtectionReady: () => (reads.checkpoint++, live.checkpoint),
    });

    expect(recoveryOperationalReadinessIsReady(source.read())).toBe(false);
    expect(reads).toEqual({ dispatch: 1, provider: 1, recording: 1, checkpoint: 1 });
    Object.assign(live, { dispatch: true, provider: true, recording: true, checkpoint: true });
    expect(recoveryOperationalReadinessIsReady(source.read())).toBe(true);
    for (const field of Object.keys(live) as Array<keyof typeof live>) {
      live[field] = false;
      expect(recoveryOperationalReadinessIsReady(source.read()), field).toBe(false);
      live[field] = true;
    }
    expect(source.read().configVersion).toBe(configuration.revision);
    expect(configuration.operationalReadiness.dispatchAdapterReady).toBe(false);
  });

  test("configuration and production readiness have a one-way runtime import graph", () => {
    const configurationSource = readFileSync(new URL("../../src/recovery-config.ts", import.meta.url), "utf8");
    const productionSource = readFileSync(new URL("../../src/services/recovery-readiness.ts", import.meta.url), "utf8");
    expect(configurationSource).not.toContain("./services/recovery-readiness.ts");
    expect(configurationSource).toContain("./domain/recovery-readiness.ts");
    expect(productionSource).toContain("../domain/recovery-readiness.ts");

    const leafSource = readFileSync(new URL("../../src/domain/recovery-readiness.ts", import.meta.url), "utf8");
    expect(leafSource).not.toMatch(/^\s*import\s/m);
    expect(leafSource).not.toContain("recovery-config");
  });

  test("production readiness and delivery seams reuse the authoritative parser", () => {
    const configuration = createRecoveryConfiguration(FULL_ENV);
    expect(readProductionDurableDeliveryPolicy(FULL_ENV)).toEqual(configuration.deliveryPolicy);
    expect(() => readProductionDurableDeliveryPolicy({ RECOVERY_DELIVERY_LEASE_MS: "1e3" })).toThrow("RECOVERY_DELIVERY_LEASE_MS");
    const readiness = createProductionRecoveryReadinessSource(FULL_ENV, {
      dispatchAdapterReady: () => false,
      providerAdapterReady: () => false,
    }).read();
    expect(readiness).toEqual(configuration.operationalReadiness);
    expect(readiness.configVersion).toBe(configuration.revision);
    expect(() => startProductionCapabilityHeartbeat({
      db: {} as never,
      component: "api",
      owner: "synthetic-config-owner",
      environment: {
        RECOVERY_CAPABILITY_LEASE_MS: "1e3",
        RECOVERY_CAPABILITY_HEARTBEAT_MS: "10",
      },
      readinessSource: { read: () => UNSET_RECOVERY_OPERATIONAL_READINESS },
    })).toThrow("RECOVERY_CAPABILITY_LEASE_MS");
  });
});
