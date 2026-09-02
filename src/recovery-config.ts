import { createHash } from "node:crypto";
import {
  providerV2PlannerLimitsAreReady,
  type ProviderV2PlannerLimits,
} from "./providers/transcription/provider-v2-planner.ts";
import {
  vexaRecoveryPreflightPolicyIsReady,
  type VexaRecoveryPreflightPolicy,
} from "./providers/vexa/recovery-preflight.ts";
import {
  recoveryAcceptancePolicyIsReady,
  type RecoveryAcceptancePolicy,
} from "./services/recovery.ts";
import {
  recoveryOperationalReadinessIsReady,
  type RecoveryOperationalReadiness,
} from "./domain/recovery-readiness.ts";
import {
  durableDeliveryMaintenanceIsReady,
  type DurableDeliveryPolicy,
} from "./worker/outbox.ts";
import {
  durableFinalizerPolicyIsReady,
  type DurableFinalizerPolicy,
} from "./worker/recovery-finalizer.ts";

export type RecoveryEnvironment = Record<string, string | undefined>;

/**
 * Authoritative non-secret B5 recovery surface. Every name is mirrored into deployment examples
 * and both API/worker compose environments by a registry-parity test.
 */
export const RECOVERY_ENV_FIELDS = Object.freeze([
  "RECOVERY_V2_ENABLED",
  "RECOVERY_PROVIDER_ENABLED",
  "RECOVERY_FINALIZER_ENABLED",
  "RECOVERY_VEXA_FALLBACK_ENABLED",
  "RECOVERY_SEGMENTATION_MODE",
  "RECOVERY_MANUAL_CYCLES_PER_MEETING",
  "RECOVERY_COOLDOWN_BASE_MS",
  "RECOVERY_COOLDOWN_MAX_MS",
  "RECOVERY_MAX_SOURCE_DURATION_MS",
  "RECOVERY_MAX_SOURCE_PCM_BYTES",
  "RECOVERY_MAX_RECORDING_BYTES",
  "RECOVERY_PROVIDER_MAX_CHUNK_DURATION_MS",
  "RECOVERY_PROVIDER_MAX_WAV_BYTES",
  "RECOVERY_MAX_CHUNK_DURATION_MS",
  "RECOVERY_MAX_WAV_BYTES",
  "RECOVERY_MAX_CALLS_PER_OPERATION",
  "RECOVERY_MAX_SUBMITTED_AUDIO_MS_PER_OPERATION",
  "RECOVERY_MAX_COST_MICROUNITS_PER_OPERATION",
  "RECOVERY_MAX_CONCURRENT_PROVIDER_CALLS",
  "RECOVERY_OPERATION_DEADLINE_MS",
  "RECOVERY_DELAYED_THRESHOLD_MS",
  "RECOVERY_SPLIT_FLOOR_MS",
  "RECOVERY_RETRY_BASE_MS",
  "RECOVERY_MAX_RETRY_AFTER_MS",
  "RECOVERY_PROJECT_MANUAL_CYCLES",
  "RECOVERY_PROJECT_AUTOMATIC_CYCLES",
  "RECOVERY_PROJECT_MAX_CALLS",
  "RECOVERY_PROJECT_MAX_SUBMITTED_AUDIO_MS",
  "RECOVERY_PROJECT_MAX_COST_MICROUNITS",
  "RECOVERY_PLAN_MAX_CHUNKS",
  "RECOVERY_PLAN_MAX_CANDIDATES",
  "RECOVERY_PLAN_QUIET_SEARCH_MS",
  "RECOVERY_PLAN_QUIET_WINDOW_MS",
  "RECOVERY_PLAN_SILENCE_THRESHOLD_DBFS",
  "RECOVERY_RECORDING_MAX_MEDIA_FILES",
  "RECOVERY_RECORDING_MAX_METADATA_STRING_LENGTH",
  "RECOVERY_RECORDING_ALLOWED_MEDIA_TYPES",
  "RECOVERY_RECORDING_MAX_DURATION_MS",
  "RECOVERY_RECORDING_MAX_BYTES",
  "RECOVERY_DELIVERY_LEASE_MS",
  "RECOVERY_DELIVERY_MAX_ATTEMPTS",
  "RECOVERY_DELIVERY_MAX_AGE_MS",
  "RECOVERY_DELIVERY_RETRY_DELAY_MS",
  "RECOVERY_DELIVERY_IDLE_MS",
  "RECOVERY_CAPABILITY_LEASE_MS",
  "RECOVERY_CAPABILITY_HEARTBEAT_MS",
  "RECOVERY_RETENTION_POLICY_VERSION",
  "RECOVERY_PRICE_VERSION",
  "RECOVERY_API_BUILD_REVISION",
  "RECOVERY_WORKER_BUILD_REVISION",
  "RECOVERY_API_CONTRACT_VERSION",
  "RECOVERY_WORKER_CONTRACT_VERSION",
  "RECOVERY_FINALIZER_VERSION",
  "RECOVERY_SCHEMA_VERSION",
] as const);

export type RecoveryEnvironmentField = (typeof RECOVERY_ENV_FIELDS)[number];

/** Complete non-secret deployment surface, including immutable image provenance. */
export const RECOVERY_DEPLOYMENT_ENV_FIELDS = Object.freeze([
  "PTX_IMAGE",
  ...RECOVERY_ENV_FIELDS,
] as const);

export type RecoveryDeploymentEnvironmentField = (typeof RECOVERY_DEPLOYMENT_ENV_FIELDS)[number];

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_PLANNED_CHUNKS = 100_000;
const MAX_PLANNING_CANDIDATES = 1_000_000;
const VERSION = /^[A-Za-z0-9._:-]+$/;
const MEDIA_TYPE = /^audio\/[a-z0-9][a-z0-9.+-]*$/;
const IMAGE_REFERENCE_MAX_LENGTH = 512;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const IMAGE_REPOSITORY_COMPONENT = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const IMAGE_HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class RecoveryConfigurationError extends TypeError {
  constructor(readonly field: string, detail: string) {
    super(`${field}: ${detail}`);
    this.name = "RecoveryConfigurationError";
  }
}

function invalid(field: string, detail: string): never {
  throw new RecoveryConfigurationError(field, detail);
}

function optionalBoolean(environment: RecoveryEnvironment, field: RecoveryEnvironmentField): boolean {
  const value = environment[field];
  if (value === undefined) return false;
  if (value !== "true" && value !== "false") invalid(field, 'must be exactly "true" or "false"');
  return value === "true";
}

function optionalUnsigned(
  environment: RecoveryEnvironment,
  field: RecoveryEnvironmentField,
  options: { minimum?: number; maximum?: number } = {},
): number | null {
  const value = environment[field];
  if (value === undefined) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) invalid(field, "must be an unsigned base-10 integer");
  const parsed = BigInt(value);
  const minimum = BigInt(options.minimum ?? 1);
  const maximum = BigInt(options.maximum ?? MAX_SAFE_INTEGER);
  if (parsed < minimum || parsed > maximum) invalid(field, `must be between ${minimum} and ${maximum}`);
  return Number(parsed);
}

function optionalBigint(
  environment: RecoveryEnvironment,
  field: RecoveryEnvironmentField,
  minimum = 0n,
): bigint | null {
  const value = environment[field];
  if (value === undefined) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) invalid(field, "must be an unsigned base-10 integer");
  const parsed = BigInt(value);
  if (parsed < minimum || parsed > POSTGRES_BIGINT_MAX) {
    invalid(field, `must fit PostgreSQL bigint (${minimum}..${POSTGRES_BIGINT_MAX})`);
  }
  return parsed;
}

function optionalSilenceThreshold(environment: RecoveryEnvironment): number | null {
  const field = "RECOVERY_PLAN_SILENCE_THRESHOLD_DBFS" as const;
  const value = environment[field];
  if (value === undefined) return null;
  if (!/^(?:0|-[1-9][0-9]*)$/.test(value)) invalid(field, "must be a non-positive base-10 integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalid(field, "must fit the runtime numeric representation");
  return parsed;
}

function optionalVersion(
  environment: RecoveryEnvironment,
  field: RecoveryEnvironmentField,
  maximumLength: number,
): string | null {
  const value = environment[field];
  if (value === undefined) return null;
  if (value.length < 1 || value.length > maximumLength || !VERSION.test(value)) {
    invalid(field, `must be 1-${maximumLength} opaque version characters`);
  }
  return value;
}

function optionalSegmentation(environment: RecoveryEnvironment): "speaker_aware" | null {
  const field = "RECOVERY_SEGMENTATION_MODE" as const;
  const value = environment[field];
  if (value === undefined) return null;
  if (value !== "speaker_aware") invalid(field, 'must be exactly "speaker_aware"');
  return value;
}

function optionalMediaTypes(environment: RecoveryEnvironment): readonly string[] | null {
  const field = "RECOVERY_RECORDING_ALLOWED_MEDIA_TYPES" as const;
  const value = environment[field];
  if (value === undefined) return null;
  const values = value.split(",");
  if (values.length < 1
    || values.length > 32
    || values.some((item) => item.length < 1 || item.length > 128 || !MEDIA_TYPE.test(item))
    || new Set(values).size !== values.length) {
    invalid(field, "must be a unique comma-separated list of bounded lowercase audio media types");
  }
  return Object.freeze([...values]);
}

function ifBoth(left: number | bigint | null, right: number | bigint | null, check: () => boolean, field: string, detail: string): void {
  if (left !== null && right !== null && !check()) invalid(field, detail);
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function registryIsValid(value: string): boolean {
  let host = value;
  const portSeparator = value.indexOf(":");
  if (portSeparator !== -1) {
    if (portSeparator !== value.lastIndexOf(":")) return false;
    host = value.slice(0, portSeparator);
    const port = value.slice(portSeparator + 1);
    if (!/^[0-9]+$/.test(port)) return false;
    const parsedPort = BigInt(port);
    if (parsedPort < 1n || parsedPort > 65_535n) return false;
  }
  if (host.length < 1 || host.length > 253) return false;
  if (host === "localhost") return true;
  return host.split(".").every((label) => IMAGE_HOST_LABEL.test(label));
}

function parseImmutableRecoveryImage(value: string | undefined): { digest: string } | null {
  if (typeof value !== "string" || value.length < 1 || value.length > IMAGE_REFERENCE_MAX_LENGTH) return null;
  if (value.includes("://") || /[\u0000-\u0020\u007f]/.test(value)) return null;

  const digestSeparator = value.indexOf("@");
  if (digestSeparator < 1 || digestSeparator !== value.lastIndexOf("@")) return null;
  const name = value.slice(0, digestSeparator);
  const digest = value.slice(digestSeparator + 1);
  if (!IMAGE_DIGEST.test(digest)) return null;

  const components = name.split("/");
  if (components.some((component) => component.length < 1)) return null;
  const repository = components.length > 1 ? components.slice(1) : components;
  if (components.length > 1 && !registryIsValid(components[0]!)) return null;

  const finalComponent = repository.at(-1)!;
  const tagSeparator = finalComponent.indexOf(":");
  if (tagSeparator !== -1 && tagSeparator !== finalComponent.lastIndexOf(":")) return null;
  const repositoryName = tagSeparator === -1 ? finalComponent : finalComponent.slice(0, tagSeparator);
  const tag = tagSeparator === -1 ? null : finalComponent.slice(tagSeparator + 1);
  if (tag !== null && !IMAGE_TAG.test(tag)) return null;
  if (!repository.slice(0, -1).every((component) => IMAGE_REPOSITORY_COMPONENT.test(component))) return null;
  if (!IMAGE_REPOSITORY_COMPONENT.test(repositoryName)) return null;
  return { digest };
}

export function recoveryImageReferenceIsImmutable(value: string | undefined): boolean {
  return parseImmutableRecoveryImage(value) !== null;
}

function trustedRecoveryImageDigest(value: string | undefined): string | null {
  return parseImmutableRecoveryImage(value)?.digest ?? null;
}

export interface RecoveryConfigurationEvidence {
  dispatchAdapterReady?: boolean;
  providerAdapterReady?: boolean;
  recordingAdapterReady?: boolean;
  checkpointProtectionReady?: boolean;
}

export interface RecoverySwitches {
  acceptance: boolean;
  providerV2Dispatch: boolean;
  durableFinalizer: boolean;
  vexaFallback: boolean;
}

export interface RecoveryConfiguration {
  readonly switches: Readonly<RecoverySwitches>;
  readonly segmentationMode: "speaker_aware" | null;
  readonly acceptancePolicy: RecoveryAcceptancePolicy;
  readonly recordingPolicy: VexaRecoveryPreflightPolicy | null;
  readonly plannerLimits: ProviderV2PlannerLimits | null;
  readonly finalizerPolicy: DurableFinalizerPolicy | null;
  readonly deliveryPolicy: DurableDeliveryPolicy;
  readonly capabilityTimings: Readonly<{ leaseMs: number | null; heartbeatMs: number | null }>;
  readonly operationalReadiness: RecoveryOperationalReadiness;
  readonly snapshot: Readonly<Record<string, unknown>> & { readonly readiness: Readonly<Record<string, boolean>> };
  readonly revision: string;
}

/** Construct the complete recovery policy graph from one injected environment record. */
export function createRecoveryConfiguration(
  environment: RecoveryEnvironment,
  evidence: RecoveryConfigurationEvidence = {},
): RecoveryConfiguration {
  const switches = Object.freeze({
    acceptance: optionalBoolean(environment, "RECOVERY_V2_ENABLED"),
    providerV2Dispatch: optionalBoolean(environment, "RECOVERY_PROVIDER_ENABLED"),
    durableFinalizer: optionalBoolean(environment, "RECOVERY_FINALIZER_ENABLED"),
    vexaFallback: optionalBoolean(environment, "RECOVERY_VEXA_FALLBACK_ENABLED"),
  });
  if (environment.PTX_IMAGE !== undefined
    && Object.values(switches).some((enabled) => enabled)
    && !recoveryImageReferenceIsImmutable(environment.PTX_IMAGE)) {
    invalid("PTX_IMAGE", "must be an immutable OCI name@sha256:<64 lowercase hex> reference for recovery");
  }
  const segmentationMode = optionalSegmentation(environment);

  const manualMeetingCycles = optionalUnsigned(environment, "RECOVERY_MANUAL_CYCLES_PER_MEETING", { maximum: POSTGRES_INTEGER_MAX });
  const cooldownBaseMs = optionalUnsigned(environment, "RECOVERY_COOLDOWN_BASE_MS", { maximum: POSTGRES_INTEGER_MAX });
  const cooldownMaxMs = optionalUnsigned(environment, "RECOVERY_COOLDOWN_MAX_MS", { maximum: POSTGRES_INTEGER_MAX });
  const maxSourceDurationMs = optionalUnsigned(environment, "RECOVERY_MAX_SOURCE_DURATION_MS", { maximum: POSTGRES_INTEGER_MAX });
  const maxSourcePcmBytes = optionalUnsigned(environment, "RECOVERY_MAX_SOURCE_PCM_BYTES");
  const maxRecordingBytes = optionalUnsigned(environment, "RECOVERY_MAX_RECORDING_BYTES");
  const providerMaxChunkDurationMs = optionalUnsigned(environment, "RECOVERY_PROVIDER_MAX_CHUNK_DURATION_MS", { maximum: POSTGRES_INTEGER_MAX });
  const providerMaxWavBytes = optionalUnsigned(environment, "RECOVERY_PROVIDER_MAX_WAV_BYTES");
  const maxChunkDurationMs = optionalUnsigned(environment, "RECOVERY_MAX_CHUNK_DURATION_MS", { maximum: POSTGRES_INTEGER_MAX });
  const maxWavBytes = optionalUnsigned(environment, "RECOVERY_MAX_WAV_BYTES");
  const maxOperationCalls = optionalUnsigned(environment, "RECOVERY_MAX_CALLS_PER_OPERATION", { maximum: POSTGRES_INTEGER_MAX });
  const maxOperationAudioMs = optionalUnsigned(environment, "RECOVERY_MAX_SUBMITTED_AUDIO_MS_PER_OPERATION");
  const maxOperationCostMicrounits = optionalBigint(environment, "RECOVERY_MAX_COST_MICROUNITS_PER_OPERATION", 1n);
  const maxConcurrentCalls = optionalUnsigned(environment, "RECOVERY_MAX_CONCURRENT_PROVIDER_CALLS", { maximum: POSTGRES_INTEGER_MAX });
  const operationDeadlineMs = optionalUnsigned(environment, "RECOVERY_OPERATION_DEADLINE_MS", { maximum: POSTGRES_INTEGER_MAX });
  const delayedThresholdMs = optionalUnsigned(environment, "RECOVERY_DELAYED_THRESHOLD_MS", { maximum: POSTGRES_INTEGER_MAX });
  const splitFloorMs = optionalUnsigned(environment, "RECOVERY_SPLIT_FLOOR_MS", { maximum: POSTGRES_INTEGER_MAX });
  const retryBackoffMs = optionalUnsigned(environment, "RECOVERY_RETRY_BASE_MS", { maximum: POSTGRES_INTEGER_MAX });
  const maxRetryAfterMs = optionalUnsigned(environment, "RECOVERY_MAX_RETRY_AFTER_MS", { maximum: POSTGRES_INTEGER_MAX });

  const projectManualCycles = optionalUnsigned(environment, "RECOVERY_PROJECT_MANUAL_CYCLES", { maximum: POSTGRES_INTEGER_MAX });
  const projectAutomaticCycles = optionalUnsigned(environment, "RECOVERY_PROJECT_AUTOMATIC_CYCLES", { minimum: 0, maximum: POSTGRES_INTEGER_MAX });
  const projectMaxCalls = optionalUnsigned(environment, "RECOVERY_PROJECT_MAX_CALLS", { maximum: POSTGRES_INTEGER_MAX });
  const projectMaxAudioMs = optionalUnsigned(environment, "RECOVERY_PROJECT_MAX_SUBMITTED_AUDIO_MS");
  const projectMaxCostMicrounits = optionalBigint(environment, "RECOVERY_PROJECT_MAX_COST_MICROUNITS", 1n);

  const maxChunks = optionalUnsigned(environment, "RECOVERY_PLAN_MAX_CHUNKS", { maximum: MAX_PLANNED_CHUNKS });
  const maxPlanningCandidates = optionalUnsigned(environment, "RECOVERY_PLAN_MAX_CANDIDATES", { maximum: MAX_PLANNING_CANDIDATES });
  const quietSearchMs = optionalUnsigned(environment, "RECOVERY_PLAN_QUIET_SEARCH_MS", { maximum: POSTGRES_INTEGER_MAX });
  const quietWindowMs = optionalUnsigned(environment, "RECOVERY_PLAN_QUIET_WINDOW_MS", { maximum: POSTGRES_INTEGER_MAX });
  const silenceThresholdDbfs = optionalSilenceThreshold(environment);

  const maxMediaFilesPerRecording = optionalUnsigned(environment, "RECOVERY_RECORDING_MAX_MEDIA_FILES", { maximum: 32 });
  const maxMetadataStringLength = optionalUnsigned(environment, "RECOVERY_RECORDING_MAX_METADATA_STRING_LENGTH", { maximum: 128 });
  const allowedMediaTypes = optionalMediaTypes(environment);
  const recordingMaxDurationMs = optionalUnsigned(environment, "RECOVERY_RECORDING_MAX_DURATION_MS", { maximum: POSTGRES_INTEGER_MAX });
  const recordingMaxBytes = optionalUnsigned(environment, "RECOVERY_RECORDING_MAX_BYTES");

  const deliveryPolicy: DurableDeliveryPolicy = Object.freeze({
    leaseMs: optionalUnsigned(environment, "RECOVERY_DELIVERY_LEASE_MS", { maximum: POSTGRES_INTEGER_MAX }),
    maxAttempts: optionalUnsigned(environment, "RECOVERY_DELIVERY_MAX_ATTEMPTS", { maximum: POSTGRES_INTEGER_MAX }),
    maxAgeMs: optionalUnsigned(environment, "RECOVERY_DELIVERY_MAX_AGE_MS", { maximum: POSTGRES_INTEGER_MAX }),
    retryDelayMs: optionalUnsigned(environment, "RECOVERY_DELIVERY_RETRY_DELAY_MS", { maximum: POSTGRES_INTEGER_MAX }),
    idleMs: optionalUnsigned(environment, "RECOVERY_DELIVERY_IDLE_MS", { maximum: POSTGRES_INTEGER_MAX }),
  });
  const capabilityTimings = Object.freeze({
    leaseMs: optionalUnsigned(environment, "RECOVERY_CAPABILITY_LEASE_MS", { maximum: POSTGRES_INTEGER_MAX }),
    heartbeatMs: optionalUnsigned(environment, "RECOVERY_CAPABILITY_HEARTBEAT_MS", { maximum: POSTGRES_INTEGER_MAX }),
  });
  const retentionPolicyVersion = optionalVersion(environment, "RECOVERY_RETENTION_POLICY_VERSION", 128);
  const priceVersion = optionalVersion(environment, "RECOVERY_PRICE_VERSION", 128);
  const apiBuildRevision = optionalVersion(environment, "RECOVERY_API_BUILD_REVISION", 128);
  const workerBuildRevision = optionalVersion(environment, "RECOVERY_WORKER_BUILD_REVISION", 128);
  const apiContractVersion = optionalVersion(environment, "RECOVERY_API_CONTRACT_VERSION", 64);
  const workerContractVersion = optionalVersion(environment, "RECOVERY_WORKER_CONTRACT_VERSION", 64);
  const finalizerVersion = optionalVersion(environment, "RECOVERY_FINALIZER_VERSION", 64);
  const schemaVersion = optionalVersion(environment, "RECOVERY_SCHEMA_VERSION", 64);

  ifBoth(cooldownBaseMs, cooldownMaxMs, () => cooldownBaseMs! <= cooldownMaxMs!, "RECOVERY_COOLDOWN_BASE_MS", "must not exceed RECOVERY_COOLDOWN_MAX_MS");
  if (projectAutomaticCycles !== null && projectAutomaticCycles !== 0) {
    invalid("RECOVERY_PROJECT_AUTOMATIC_CYCLES", "must be exactly 0 for the manual-only first release");
  }
  ifBoth(recordingMaxDurationMs, maxSourceDurationMs, () => recordingMaxDurationMs! <= maxSourceDurationMs!, "RECOVERY_RECORDING_MAX_DURATION_MS", "must not exceed the accepted source duration");
  ifBoth(recordingMaxBytes, maxRecordingBytes, () => recordingMaxBytes! <= maxRecordingBytes!, "RECOVERY_RECORDING_MAX_BYTES", "must not exceed the accepted recording byte limit");
  ifBoth(maxChunkDurationMs, providerMaxChunkDurationMs, () => maxChunkDurationMs! < providerMaxChunkDurationMs!, "RECOVERY_MAX_CHUNK_DURATION_MS", "must be strictly below the provider duration ceiling");
  ifBoth(maxChunkDurationMs, maxSourceDurationMs, () => maxChunkDurationMs! < maxSourceDurationMs!, "RECOVERY_MAX_CHUNK_DURATION_MS", "must be strictly below the source duration bound");
  ifBoth(maxWavBytes, providerMaxWavBytes, () => maxWavBytes! < providerMaxWavBytes!, "RECOVERY_MAX_WAV_BYTES", "must be strictly below the provider WAV ceiling");
  ifBoth(maxWavBytes, maxSourcePcmBytes, () => maxWavBytes! < maxSourcePcmBytes!, "RECOVERY_MAX_WAV_BYTES", "must be strictly below the source PCM bound");
  ifBoth(maxOperationCalls, projectMaxCalls, () => maxOperationCalls! <= projectMaxCalls!, "RECOVERY_MAX_CALLS_PER_OPERATION", "must not exceed the project call cap");
  ifBoth(maxOperationAudioMs, projectMaxAudioMs, () => maxOperationAudioMs! <= projectMaxAudioMs!, "RECOVERY_MAX_SUBMITTED_AUDIO_MS_PER_OPERATION", "must not exceed the project audio cap");
  ifBoth(maxOperationCostMicrounits, projectMaxCostMicrounits, () => maxOperationCostMicrounits! <= projectMaxCostMicrounits!, "RECOVERY_MAX_COST_MICROUNITS_PER_OPERATION", "must not exceed the project cost cap");
  ifBoth(delayedThresholdMs, operationDeadlineMs, () => delayedThresholdMs! < operationDeadlineMs!, "RECOVERY_DELAYED_THRESHOLD_MS", "must be strictly below the hard operation deadline");
  ifBoth(retryBackoffMs, maxRetryAfterMs, () => retryBackoffMs! <= maxRetryAfterMs!, "RECOVERY_RETRY_BASE_MS", "must not exceed the maximum Retry-After");
  ifBoth(maxConcurrentCalls, maxOperationCalls, () => maxConcurrentCalls! <= maxOperationCalls!, "RECOVERY_MAX_CONCURRENT_PROVIDER_CALLS", "must not exceed the operation call cap");
  ifBoth(maxConcurrentCalls, projectMaxCalls, () => maxConcurrentCalls! <= projectMaxCalls!, "RECOVERY_MAX_CONCURRENT_PROVIDER_CALLS", "must not exceed the project call cap");
  for (const [field, wake] of [
    ["RECOVERY_RETRY_BASE_MS", retryBackoffMs],
    ["RECOVERY_MAX_RETRY_AFTER_MS", maxRetryAfterMs],
    ["RECOVERY_DELIVERY_LEASE_MS", deliveryPolicy.leaseMs],
    ["RECOVERY_DELIVERY_RETRY_DELAY_MS", deliveryPolicy.retryDelayMs],
    ["RECOVERY_DELIVERY_IDLE_MS", deliveryPolicy.idleMs],
  ] as const) {
    ifBoth(wake, operationDeadlineMs, () => wake! <= operationDeadlineMs!, field, "must not exceed the hard operation deadline");
  }
  ifBoth(splitFloorMs, maxChunkDurationMs, () => splitFloorMs! < maxChunkDurationMs!, "RECOVERY_SPLIT_FLOOR_MS", "must be strictly below the local chunk duration ceiling");
  ifBoth(quietWindowMs, quietSearchMs, () => quietWindowMs! <= quietSearchMs!, "RECOVERY_PLAN_QUIET_WINDOW_MS", "must not exceed the quiet search range");
  ifBoth(quietSearchMs, maxChunkDurationMs, () => quietSearchMs! < maxChunkDurationMs!, "RECOVERY_PLAN_QUIET_SEARCH_MS", "must be strictly below the local chunk duration ceiling");
  ifBoth(maxPlanningCandidates, maxChunks, () => maxPlanningCandidates! >= maxChunks!, "RECOVERY_PLAN_MAX_CANDIDATES", "must cover at least the maximum planned chunk count");
  ifBoth(capabilityTimings.heartbeatMs, capabilityTimings.leaseMs, () => capabilityTimings.heartbeatMs! < capabilityTimings.leaseMs!, "RECOVERY_CAPABILITY_HEARTBEAT_MS", "must be strictly below the capability lease");
  ifBoth(deliveryPolicy.leaseMs, deliveryPolicy.maxAgeMs, () => deliveryPolicy.leaseMs! <= deliveryPolicy.maxAgeMs!, "RECOVERY_DELIVERY_LEASE_MS", "must not exceed the durable delivery age bound");
  ifBoth(deliveryPolicy.retryDelayMs, deliveryPolicy.maxAgeMs, () => deliveryPolicy.retryDelayMs! <= deliveryPolicy.maxAgeMs!, "RECOVERY_DELIVERY_RETRY_DELAY_MS", "must not exceed the durable delivery age bound");
  if (apiContractVersion !== null && workerContractVersion !== null && apiContractVersion !== workerContractVersion) {
    invalid("RECOVERY_WORKER_CONTRACT_VERSION", "must match RECOVERY_API_CONTRACT_VERSION");
  }
  if (allowedMediaTypes && maxMediaFilesPerRecording !== null && allowedMediaTypes.length > maxMediaFilesPerRecording) {
    invalid("RECOVERY_RECORDING_ALLOWED_MEDIA_TYPES", "must not exceed the recording media-file bound");
  }
  if (allowedMediaTypes && maxMetadataStringLength !== null
    && allowedMediaTypes.some((value) => value.length > maxMetadataStringLength)) {
    invalid("RECOVERY_RECORDING_ALLOWED_MEDIA_TYPES", "contains a value longer than the metadata string bound");
  }

  const recordingPolicy = [maxMediaFilesPerRecording, maxMetadataStringLength, allowedMediaTypes, recordingMaxDurationMs, recordingMaxBytes]
    .every((value) => value !== null)
    ? Object.freeze({
      maxMediaFilesPerRecording: maxMediaFilesPerRecording!,
      maxMetadataStringLength: maxMetadataStringLength!,
      allowedMediaTypes: allowedMediaTypes!,
      maxDurationMs: recordingMaxDurationMs!,
      maxBytes: recordingMaxBytes!,
    })
    : null;
  if (recordingPolicy && !vexaRecoveryPreflightPolicyIsReady(recordingPolicy)) {
    invalid("RECOVERY_RECORDING_ALLOWED_MEDIA_TYPES", "does not form a valid recording policy");
  }

  const plannerValues = [
    maxSourceDurationMs, maxSourcePcmBytes, providerMaxChunkDurationMs, providerMaxWavBytes,
    maxChunkDurationMs, maxWavBytes, maxChunks, maxOperationAudioMs, maxPlanningCandidates,
    quietSearchMs, quietWindowMs, silenceThresholdDbfs,
  ];
  const plannerLimits: ProviderV2PlannerLimits | null = plannerValues.every((value) => value !== null)
    ? Object.freeze({
      maxSourceDurationMs: maxSourceDurationMs!,
      maxSourcePcmBytes: maxSourcePcmBytes!,
      providerMaxChunkDurationMs: providerMaxChunkDurationMs!,
      providerMaxWavBytes: providerMaxWavBytes!,
      maxChunkDurationMs: maxChunkDurationMs!,
      maxWavBytes: maxWavBytes!,
      maxChunks: maxChunks!,
      maxTotalSubmittedAudioMs: maxOperationAudioMs!,
      maxPlanningCandidates: maxPlanningCandidates!,
      quietSearchMs: quietSearchMs!,
      quietWindowMs: quietWindowMs!,
      silenceThresholdDbfs: silenceThresholdDbfs!,
    })
    : null;
  if (plannerLimits && !providerV2PlannerLimitsAreReady(plannerLimits)) {
    invalid("RECOVERY_MAX_WAV_BYTES", "configured values do not form an accepted provider-v2 planner policy");
  }

  const projectBudget = Object.freeze({
    manualCycles: projectManualCycles,
    automaticCycles: projectAutomaticCycles,
    sharedCalls: projectMaxCalls,
    sharedAudioMs: projectMaxAudioMs,
    sharedCostMicrounits: projectMaxCostMicrounits,
  });
  const acceptancePolicy: RecoveryAcceptancePolicy = Object.freeze({
    enabled: switches.acceptance,
    providerV2Enabled: switches.providerV2Dispatch,
    manualMeetingCycles,
    cooldownBaseMs,
    cooldownMaxMs,
    retentionPolicyVersion,
    priceVersion,
    providerLimits: Object.freeze({
      maxSourceDurationMs,
      maxRecordingBytes,
      maxCallsPerOperation: maxOperationCalls,
      maxSubmittedAudioMsPerOperation: maxOperationAudioMs,
      maxConcurrency: maxConcurrentCalls,
      operationDeadlineMs,
    }),
    projectBudget,
    recording: recordingPolicy,
  });

  const finalizerValues = [
    maxOperationCalls, maxOperationAudioMs, maxOperationCostMicrounits, maxConcurrentCalls,
    splitFloorMs, retryBackoffMs, maxRetryAfterMs, operationDeadlineMs, delayedThresholdMs,
    projectManualCycles, projectAutomaticCycles, projectMaxCalls, projectMaxAudioMs,
    projectMaxCostMicrounits, plannerLimits,
  ];
  const finalizerPolicy: DurableFinalizerPolicy | null = finalizerValues.every((value) => value !== null)
    ? Object.freeze({
      fallbackEnabled: switches.vexaFallback,
      maxOperationCalls: maxOperationCalls!,
      maxOperationAudioMs: maxOperationAudioMs!,
      maxOperationCostMicrounits: maxOperationCostMicrounits!,
      maxConcurrentCalls: maxConcurrentCalls!,
      splitFloorMs: splitFloorMs!,
      retryBackoffMs: retryBackoffMs!,
      maxRetryAfterMs: maxRetryAfterMs!,
      operationDeadlineMs: operationDeadlineMs!,
      delayedThresholdMs: delayedThresholdMs!,
      projectLimits: projectBudget,
      plannerLimits: plannerLimits!,
    })
    : null;
  if (finalizerPolicy && !durableFinalizerPolicyIsReady(finalizerPolicy)) {
    invalid("RECOVERY_FINALIZER_ENABLED", "configured values do not form an accepted finalizer policy");
  }

  const acceptancePolicyReady = recoveryAcceptancePolicyIsReady(acceptancePolicy);
  const plannerReady = plannerLimits !== null && providerV2PlannerLimitsAreReady(plannerLimits);
  const finalizerPolicyReady = finalizerPolicy !== null && durableFinalizerPolicyIsReady(finalizerPolicy);
  const durableDeliveryReady = durableDeliveryMaintenanceIsReady(deliveryPolicy);
  const capabilityTimingsReady = capabilityTimings.leaseMs !== null
    && capabilityTimings.heartbeatMs !== null
    && capabilityTimings.heartbeatMs < capabilityTimings.leaseMs;
  const imageDigest = trustedRecoveryImageDigest(environment.PTX_IMAGE);
  const immutableImageReady = imageDigest !== null;

  const sanitized = {
    deployment: { imageDigest },
    switches,
    segmentationMode,
    limits: {
      source: { maxDurationMs: maxSourceDurationMs, maxPcmBytes: maxSourcePcmBytes, maxRecordingBytes },
      provider: { maxChunkDurationMs: providerMaxChunkDurationMs, maxWavBytes: providerMaxWavBytes, maxConcurrentCalls },
      operation: {
        maxCalls: maxOperationCalls,
        maxSubmittedAudioMs: maxOperationAudioMs,
        maxCostMicrounits: maxOperationCostMicrounits?.toString() ?? null,
        deadlineMs: operationDeadlineMs,
        delayedThresholdMs,
        splitFloorMs,
        retryBaseMs: retryBackoffMs,
        maxRetryAfterMs,
      },
      project: {
        manualCycles: projectManualCycles,
        automaticCycles: projectAutomaticCycles,
        maxCalls: projectMaxCalls,
        maxSubmittedAudioMs: projectMaxAudioMs,
        maxCostMicrounits: projectMaxCostMicrounits?.toString() ?? null,
      },
      planner: plannerLimits,
      recording: recordingPolicy,
      delivery: deliveryPolicy,
      capability: capabilityTimings,
      manualCyclesPerMeeting: manualMeetingCycles,
      cooldown: { baseMs: cooldownBaseMs, maxMs: cooldownMaxMs },
    },
    versions: {
      retentionPolicy: retentionPolicyVersion,
      price: priceVersion,
      apiBuild: apiBuildRevision,
      workerBuild: workerBuildRevision,
      apiContract: apiContractVersion,
      workerContract: workerContractVersion,
      finalizer: finalizerVersion,
      schema: schemaVersion,
    },
  };
  const revision = `rcfg_${createHash("sha256").update(canonicalJson(sanitized)).digest("hex")}`;
  const operationalReadiness: RecoveryOperationalReadiness = Object.freeze({
    recoveryAcceptanceEnabled: switches.acceptance,
    maintenanceConfigured: durableDeliveryReady && capabilityTimingsReady,
    providerEnabled: switches.providerV2Dispatch,
    finalizerEnabled: switches.durableFinalizer,
    dispatchAdapterReady: evidence.dispatchAdapterReady === true && immutableImageReady,
    providerAdapterReady: evidence.providerAdapterReady === true
      && evidence.recordingAdapterReady === true
      && evidence.checkpointProtectionReady === true
      && immutableImageReady,
    a3BudgetConfigReady: acceptancePolicyReady,
    bProviderConfigReady: plannerReady && segmentationMode === "speaker_aware",
    bFinalizerConfigReady: finalizerPolicyReady,
    apiBuildRevision,
    workerBuildRevision,
    apiContractVersion,
    workerContractVersion,
    finalizerVersion,
    schemaVersion,
    configVersion: revision,
  });
  const readiness = Object.freeze({
    acceptancePolicy: acceptancePolicyReady,
    recordingPolicy: recordingPolicy !== null,
    planner: plannerReady,
    finalizerPolicy: finalizerPolicyReady,
    durableDelivery: durableDeliveryReady,
    capabilityTimings: capabilityTimingsReady,
    immutableImage: immutableImageReady,
    dispatchAdapter: operationalReadiness.dispatchAdapterReady,
    providerAdapter: evidence.providerAdapterReady === true,
    recordingAdapter: evidence.recordingAdapterReady === true,
    checkpointProtection: evidence.checkpointProtectionReady === true,
    operational: recoveryOperationalReadinessIsReady(operationalReadiness),
  });
  const snapshot = deepFreeze({ ...sanitized, readiness, revision });
  return Object.freeze({
    switches,
    segmentationMode,
    acceptancePolicy,
    recordingPolicy,
    plannerLimits,
    finalizerPolicy,
    deliveryPolicy,
    capabilityTimings,
    operationalReadiness,
    snapshot,
    revision,
  });
}
