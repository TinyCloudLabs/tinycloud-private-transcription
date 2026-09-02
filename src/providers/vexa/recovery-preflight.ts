import { VexaHttpError } from "./client.ts";

export type VexaRecoveryAvailability = "present_unverified" | "absent" | "transient" | "permanent";

export type VexaRecoveryPreflightResult =
  | { availability: "present_unverified"; code: "recording_present_unverified"; status: 200 }
  | { availability: "absent"; code: "recording_absent"; status: 410 }
  | { availability: "transient"; code: "recording_fetch_transient"; status: 503 }
  | { availability: "permanent"; code: "recording_metadata_unsupported"; status: 409 };

export interface VexaRecoveryPreflightPolicy {
  maxMediaFilesPerRecording: number;
  maxMetadataStringLength: number;
  allowedMediaTypes: readonly string[];
  maxDurationMs: number;
  maxBytes: number;
}

export interface VexaRecoveryMediaMetadata {
  type: string;
  format: string;
  isFinal: boolean;
  bytes: number;
  durationMs: number;
}

export type VexaRecoveryTargetMetadata =
  | { availability: "present"; mediaFiles: readonly VexaRecoveryMediaMetadata[] }
  | { availability: "absent"; authoritativeTargetAbsence: true }
  | { availability: "unavailable" };

export interface VexaRecoveryMetadataSource {
  /**
   * A future adapter must bind the lookup to this exact owner-scoped target at the provider.
   * Owner-wide collection endpoints are not an implementation of this contract.
   */
  getTargetRecordingMetadata(target: VexaRecoveryTarget): Promise<VexaRecoveryTargetMetadata>;
}

export interface VexaRecoveryTarget {
  platform: string;
  nativeMeetingId: string;
}

const PRESENT: VexaRecoveryPreflightResult = {
  availability: "present_unverified",
  code: "recording_present_unverified",
  status: 200,
};
const ABSENT: VexaRecoveryPreflightResult = {
  availability: "absent",
  code: "recording_absent",
  status: 410,
};
const TRANSIENT: VexaRecoveryPreflightResult = {
  availability: "transient",
  code: "recording_fetch_transient",
  status: 503,
};
const PERMANENT: VexaRecoveryPreflightResult = {
  availability: "permanent",
  code: "recording_metadata_unsupported",
  status: 409,
};

class UnsupportedMetadata extends Error {}

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isPositiveFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isBoundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

export function vexaRecoveryPreflightPolicyIsReady(policy: VexaRecoveryPreflightPolicy): boolean {
  return isPositiveSafeInteger(policy.maxMediaFilesPerRecording)
    && isPositiveSafeInteger(policy.maxMetadataStringLength)
    && isPositiveSafeInteger(policy.maxDurationMs)
    && isPositiveSafeInteger(policy.maxBytes)
    && Array.isArray(policy.allowedMediaTypes)
    && policy.allowedMediaTypes.length > 0
    && policy.allowedMediaTypes.length <= policy.maxMediaFilesPerRecording
    && policy.allowedMediaTypes.every((value) => isBoundedString(value, policy.maxMetadataStringLength));
}

function boundedArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new UnsupportedMetadata();
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UnsupportedMetadata();
  return value as Record<string, unknown>;
}

function safeFailure(error: unknown): VexaRecoveryPreflightResult {
  if (error instanceof UnsupportedMetadata) return PERMANENT;
  // A collection 404 is not authoritative target absence. Until a verified target-scoped
  // adapter exists, every HTTP/transport failure is dependency unavailability.
  if (error instanceof VexaHttpError) return TRANSIENT;
  return TRANSIENT;
}

/**
 * Resolve recording availability using owner-scoped metadata only.
 *
 * This function has no audio, transcript, master-assembly, raw-body, Redis, provider, or ledger
 * dependency. It returns a closed bounded enum and deliberately discards all thrown material.
 */
export async function preflightVexaRecording(
  source: VexaRecoveryMetadataSource | null,
  target: VexaRecoveryTarget,
  policy: VexaRecoveryPreflightPolicy,
): Promise<VexaRecoveryPreflightResult> {
  if (!vexaRecoveryPreflightPolicyIsReady(policy)
    || !isBoundedString(target.platform, policy.maxMetadataStringLength)
    || !isBoundedString(target.nativeMeetingId, policy.maxMetadataStringLength)) return PERMANENT;
  if (source === null) return TRANSIENT;

  try {
    const metadata = record(await source.getTargetRecordingMetadata(target));
    if (metadata.availability === "absent") {
      return metadata.authoritativeTargetAbsence === true ? ABSENT : PERMANENT;
    }
    if (metadata.availability === "unavailable") return TRANSIENT;
    if (metadata.availability !== "present") return PERMANENT;

    const mediaFiles = boundedArray(metadata.mediaFiles, policy.maxMediaFilesPerRecording);
    let sawPresentAudio = false;
    let sawPendingAudio = false;
    let sawUnsupportedAudio = false;
    for (const rawMedia of mediaFiles) {
      const media = record(rawMedia);
      if (!isBoundedString(media.type, policy.maxMetadataStringLength)
        || !isBoundedString(media.format, policy.maxMetadataStringLength)
        || typeof media.isFinal !== "boolean") throw new UnsupportedMetadata();
      if (media.type !== "audio") {
        if (media.isFinal) sawUnsupportedAudio = true;
        continue;
      }
      if (!media.isFinal) {
        sawPendingAudio = true;
        continue;
      }
      const mediaType = `${media.type}/${media.format}`;
      if (!policy.allowedMediaTypes.includes(mediaType)
        || !isPositiveSafeInteger(media.bytes)
        || media.bytes > policy.maxBytes
        || !isPositiveFiniteNumber(media.durationMs)
        || media.durationMs > policy.maxDurationMs) {
        sawUnsupportedAudio = true;
        continue;
      }
      sawPresentAudio = true;
    }
    if (sawUnsupportedAudio) return PERMANENT;
    if (sawPresentAudio) return PRESENT;
    if (sawPendingAudio) return TRANSIENT;
    return PERMANENT;
  } catch (error) {
    return safeFailure(error);
  }
}

/**
 * The checked-in Vexa contract exposes only unbounded owner-wide collections for this metadata.
 * Production therefore has no adapter: fail closed before any network request or body read.
 */
export function defaultVexaRecoveryPreflight(
  target: VexaRecoveryTarget,
  policy: VexaRecoveryPreflightPolicy,
): Promise<VexaRecoveryPreflightResult> {
  return preflightVexaRecording(null, target, policy);
}
