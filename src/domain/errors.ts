export type ErrorCode =
  | "invalid_meeting_url"
  | "unsupported_platform"
  | "meeting_not_found"
  | "meeting_join_failed"
  | "waiting_room_timeout"
  | "bot_removed"
  | "meeting_ended"
  | "capture_failed"
  | "transcription_failed"
  | "provider_timeout"
  | "provider_unavailable"
  | "provider_rejected"
  | "finalizer_interrupted"
  | "operation_deadline_exceeded"
  | "recording_fetch_transient"
  | "recording_absent"
  | "recording_undecodable"
  | "recording_silent"
  | "attestation_failed"
  | "coverage_incomplete"
  | "budget_exhausted"
  | "persistence_failed"
  | "cancelled"
  | "deleted"
  | "validation_failed"
  | "authentication_failed"
  | "internal_error"
  // request-level codes
  | "unauthorized"
  | "insufficient_scope"
  | "invalid_request"
  | "idempotency_conflict"
  | "recovery_disabled"
  | "recovery_ineligible"
  | "recovery_cooldown"
  | "not_found";

export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "meeting_join_failed"
  | "capture_error"
  | "transcription_error"
  | "provider_error"
  | "internal_error";

const CODE_TYPE: Record<ErrorCode, ErrorType> = {
  invalid_meeting_url: "invalid_request_error",
  unsupported_platform: "invalid_request_error",
  invalid_request: "invalid_request_error",
  idempotency_conflict: "invalid_request_error",
  unauthorized: "authentication_error",
  insufficient_scope: "permission_error",
  meeting_not_found: "not_found_error",
  not_found: "not_found_error",
  recovery_disabled: "internal_error",
  recovery_ineligible: "invalid_request_error",
  recovery_cooldown: "invalid_request_error",
  meeting_join_failed: "meeting_join_failed",
  waiting_room_timeout: "meeting_join_failed",
  bot_removed: "capture_error",
  meeting_ended: "capture_error",
  capture_failed: "capture_error",
  transcription_failed: "transcription_error",
  provider_timeout: "provider_error",
  provider_unavailable: "provider_error",
  provider_rejected: "provider_error",
  finalizer_interrupted: "transcription_error",
  operation_deadline_exceeded: "transcription_error",
  recording_fetch_transient: "provider_error",
  recording_absent: "capture_error",
  recording_undecodable: "transcription_error",
  recording_silent: "transcription_error",
  attestation_failed: "provider_error",
  coverage_incomplete: "transcription_error",
  budget_exhausted: "internal_error",
  persistence_failed: "internal_error",
  cancelled: "capture_error",
  deleted: "not_found_error",
  validation_failed: "invalid_request_error",
  authentication_failed: "authentication_error",
  internal_error: "internal_error",
};

const CODE_STATUS: Partial<Record<ErrorCode, number>> = {
  invalid_meeting_url: 400,
  unsupported_platform: 400,
  invalid_request: 400,
  unauthorized: 401,
  insufficient_scope: 403,
  meeting_not_found: 404,
  not_found: 404,
  idempotency_conflict: 409,
  recovery_disabled: 503,
  recovery_ineligible: 409,
  recovery_cooldown: 429,
  provider_unavailable: 503,
  provider_timeout: 503,
  provider_rejected: 409,
  finalizer_interrupted: 503,
  operation_deadline_exceeded: 503,
  recording_fetch_transient: 503,
  recording_absent: 410,
  recording_undecodable: 409,
  recording_silent: 409,
  attestation_failed: 409,
  coverage_incomplete: 409,
  budget_exhausted: 429,
  persistence_failed: 503,
  cancelled: 409,
  deleted: 404,
  validation_failed: 400,
  authentication_failed: 401,
};

const SAFE_ERROR_MESSAGES: Record<ErrorCode, string> = {
  invalid_meeting_url: "The meeting URL is invalid.",
  unsupported_platform: "The meeting platform is not supported.",
  meeting_not_found: "No such meeting.",
  meeting_join_failed: "The bot could not join the meeting.",
  waiting_room_timeout: "The bot was not admitted to the meeting in time.",
  bot_removed: "The bot was removed from the meeting.",
  meeting_ended: "The meeting ended before a transcript could be captured.",
  capture_failed: "Meeting capture failed.",
  transcription_failed: "Transcription failed.",
  provider_timeout: "The transcription provider timed out.",
  provider_unavailable: "The transcription provider is unavailable.",
  provider_rejected: "The transcription provider rejected this request.",
  finalizer_interrupted: "Transcript finalization was interrupted.",
  operation_deadline_exceeded: "Transcript finalization exceeded its deadline.",
  recording_fetch_transient: "The recording is temporarily unavailable.",
  recording_absent: "The recording is unavailable.",
  recording_undecodable: "The recording could not be decoded.",
  recording_silent: "The recording contains no usable audio.",
  attestation_failed: "Provider verification failed.",
  coverage_incomplete: "Transcript coverage is incomplete.",
  budget_exhausted: "The recovery budget is exhausted.",
  persistence_failed: "Recovery state could not be persisted.",
  cancelled: "The meeting was cancelled.",
  deleted: "No such meeting.",
  validation_failed: "The request is invalid.",
  authentication_failed: "Authentication failed.",
  internal_error: "An internal error occurred.",
  unauthorized: "Authentication is required.",
  insufficient_scope: "This API key is not permitted to perform this action.",
  invalid_request: "The request is invalid.",
  idempotency_conflict: "The idempotency key conflicts with an existing request.",
  recovery_disabled: "Meeting recovery is not available on this deployment.",
  recovery_ineligible: "This meeting is not eligible for recovery.",
  recovery_cooldown: "Meeting recovery is cooling down.",
  not_found: "No route matches this request.",
};

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(Object.keys(CODE_TYPE));

export function safeStoredError(code: string | null | undefined): { type: ErrorType; code: ErrorCode; message: string } {
  const safeCode: ErrorCode = code && KNOWN_ERROR_CODES.has(code) ? (code as ErrorCode) : "transcription_failed";
  return { type: CODE_TYPE[safeCode], code: safeCode, message: SAFE_ERROR_MESSAGES[safeCode] };
}

/**
 * Retry taxonomy for the `retryable` hint clients see. Fail-closed: only faults we know are
 * transient are true, so a deterministic refusal served as a 5xx (recovery_disabled) does not
 * invite a retry storm, and a code this build does not recognize is never advertised as retryable.
 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set<ErrorCode>(["provider_unavailable", "provider_timeout"]);

export const isRetryableErrorCode = (code: ErrorCode): boolean => RETRYABLE_CODES.has(code);

export class ApiError extends Error {
  readonly type: ErrorType;
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  constructor(
    readonly code: ErrorCode,
    message: string,
    status?: number,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.type = CODE_TYPE[code];
    this.status = status ?? CODE_STATUS[code] ?? 500;
    this.retryAfterSeconds = Number.isSafeInteger(retryAfterSeconds)
      && retryAfterSeconds! > 0
      && retryAfterSeconds! <= 86_400
      ? retryAfterSeconds
      : null;
  }
  /**
   * The only shape we ever put on the wire for a rejection. `message` is authored by us at the
   * throw site and must stay free of provider text, configuration names, and caller input;
   * anything a responder needs beyond that is correlated through `request_id` in the logs.
   */
  toBody(requestId: string) {
    return {
      error: { type: this.type, code: this.code, message: this.message, retryable: isRetryableErrorCode(this.code) },
      request_id: requestId,
    };
  }
}

export const errorTypeFor = (code: ErrorCode): ErrorType => CODE_TYPE[code] ?? "transcription_error";
