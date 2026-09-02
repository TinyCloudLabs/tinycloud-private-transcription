/**
 * Recovery's public, snake_case wire vocabulary. This module deliberately imports nothing: routes,
 * serializers, client-facing types, and contract tests can depend on it without creating a cycle.
 */
export const RECOVERY_DISPOSITIONS = Object.freeze([
  "started",
  "already_active",
  "already_completed",
] as const);

export const RECOVERY_PHASES = Object.freeze([
  "queued",
  "preflighting",
  "chunking",
  "transcribing",
  "delayed",
  "publishing",
  "completed",
  "failed",
  "disabled",
] as const);

/** Codes for which this API knows the manual-recovery protocol, in stable presentation order. */
export const RECOVERY_SUPPORTED_ERROR_CODES = Object.freeze([
  "provider_timeout",
  "provider_unavailable",
  "finalizer_interrupted",
  "recording_fetch_transient",
] as const);

/** Bounded recovery terminal/admission codes that may appear in meeting recovery metadata. */
export const RECOVERY_SAFE_ERROR_CODES = Object.freeze([
  ...RECOVERY_SUPPORTED_ERROR_CODES,
  "operation_deadline_exceeded",
  "recording_absent",
  "recording_undecodable",
  "recording_silent",
  "provider_rejected",
  "attestation_failed",
  "coverage_incomplete",
  "budget_exhausted",
  "persistence_failed",
  "cancelled",
  "deleted",
  "validation_failed",
  "authentication_failed",
] as const);

export type RecoveryDisposition = (typeof RECOVERY_DISPOSITIONS)[number];
export type RecoveryPhase = (typeof RECOVERY_PHASES)[number];
export type RecoverySupportedErrorCode = (typeof RECOVERY_SUPPORTED_ERROR_CODES)[number];
export type RecoverySafeErrorCode = (typeof RECOVERY_SAFE_ERROR_CODES)[number];
export type RecoveryKind = "manual";

export interface MeetingRecoveryMetadata {
  eligible: boolean;
  code: RecoverySafeErrorCode | null;
  phase: RecoveryPhase | null;
  next_eligible_at: string | null;
  manual_remaining: number | null;
  automatic_enabled: false;
}

export interface RecoveryCapabilitiesResponse {
  recovery: {
    contract_version: string | null;
    manual_available: boolean;
    automatic_available: false;
    supported_error_codes: readonly RecoverySupportedErrorCode[];
  };
}

export interface RecoverMeetingResponse {
  id: string;
  status: "processing" | "completed" | "failed" | "cancelled";
  recovery: {
    operation_id: string | null;
    disposition: RecoveryDisposition;
    kind: RecoveryKind;
    phase: RecoveryPhase | null;
    attempt: number | null;
    max_attempts: number | null;
    next_eligible_at: string | null;
  };
}

const VERSION = /^[A-Za-z0-9._:-]{1,64}$/;
const MEETING_ID = /^mtg_[0-9A-HJKMNP-TV-Z]{26}$/;
const OPERATION_ID = /^rcv_[0-9A-HJKMNP-TV-Z]{26}$/;
const PHASES = new Set<string>(RECOVERY_PHASES);
const SAFE_CODES = new Set<string>(RECOVERY_SAFE_ERROR_CODES);

const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export const boundedRecoveryContractVersion = (value: unknown): string | null =>
  typeof value === "string" && VERSION.test(value) ? value : null;

export const safeRecoveryPhase = (value: unknown): RecoveryPhase | null =>
  typeof value === "string" && PHASES.has(value) ? value as RecoveryPhase : null;

export const safeRecoveryErrorCode = (value: unknown): RecoverySafeErrorCode | null =>
  typeof value === "string" && SAFE_CODES.has(value) ? value as RecoverySafeErrorCode : null;

export const safeTranscriptRevision = (value: unknown): number | null =>
  nonnegativeInteger(value) ? value : null;

function safeDate(value: unknown): string | null {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  return value.toISOString();
}

export function serializeRecoveryCapabilities(
  configuredContractVersion: unknown,
  manualAvailable: boolean,
): RecoveryCapabilitiesResponse {
  return {
    recovery: {
      contract_version: boundedRecoveryContractVersion(configuredContractVersion),
      manual_available: manualAvailable === true,
      automatic_available: false,
      supported_error_codes: RECOVERY_SUPPORTED_ERROR_CODES,
    },
  };
}

export function serializeMeetingRecovery(input: {
  status: string;
  errorCode: unknown;
  phase: unknown;
  nextEligibleAt: unknown;
  budgetProvenance: unknown;
  manualCyclesConsumed: unknown;
  manualMeetingCycles: unknown;
  eligible: boolean;
}): MeetingRecoveryMetadata {
  const code = input.status === "failed" ? safeRecoveryErrorCode(input.errorCode) : null;
  const tracked = input.budgetProvenance === "tracked";
  const consumed = nonnegativeInteger(input.manualCyclesConsumed) ? input.manualCyclesConsumed : null;
  const limit = nonnegativeInteger(input.manualMeetingCycles) ? input.manualMeetingCycles : null;
  const manualRemaining = tracked && consumed !== null && limit !== null ? Math.max(0, limit - consumed) : null;
  return {
    eligible: input.eligible === true
      && tracked
      && input.status === "failed"
      && RECOVERY_SUPPORTED_ERROR_CODES.includes(code as RecoverySupportedErrorCode)
      && manualRemaining !== null
      && manualRemaining > 0,
    code,
    phase: safeRecoveryPhase(input.phase),
    next_eligible_at: input.status === "failed" ? safeDate(input.nextEligibleAt) : null,
    manual_remaining: manualRemaining,
    automatic_enabled: false,
  };
}

export function serializeRecoverResponse(input: {
  meetingId: string;
  status: string;
  disposition: RecoveryDisposition;
  operation: { id: string; phase: unknown; ordinal: unknown } | null;
  nextEligibleAt?: unknown;
}): RecoverMeetingResponse {
  if (!MEETING_ID.test(input.meetingId)) throw new TypeError("invalid recovery meeting identifier");
  const statusIsValid = input.disposition === "already_completed"
    ? input.status === "completed"
    : input.disposition === "already_active"
      ? input.status === "processing"
      : input.status === "processing" || input.status === "completed"
        || input.status === "failed" || input.status === "cancelled";
  if (!statusIsValid) throw new TypeError("invalid recovery meeting wire state");
  const status = input.status as RecoverMeetingResponse["status"];
  if (input.operation !== null && (!OPERATION_ID.test(input.operation.id)
    || safeRecoveryPhase(input.operation.phase) === null
    || !positiveInteger(input.operation.ordinal))) {
    throw new TypeError("invalid recovery operation wire state");
  }
  const operation = input.operation;
  return {
    id: input.meetingId,
    status,
    recovery: {
      operation_id: operation?.id ?? null,
      disposition: input.disposition,
      kind: "manual",
      phase: operation ? safeRecoveryPhase(operation.phase) : null,
      attempt: operation ? 1 : null,
      // Release-one operations are a single admitted manual attempt. Provider/chunk retries are
      // internal durable work and are not represented as user recovery attempts.
      max_attempts: operation ? 1 : null,
      next_eligible_at: operation ? null : safeDate(input.nextEligibleAt),
    },
  };
}
