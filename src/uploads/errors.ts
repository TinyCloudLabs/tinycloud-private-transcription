/**
 * Stable public error codes of the batch API. Every error body is
 * `{"error":{"type","code","message","correlation_id", ...extra}}`; `code` values are a contract (SPEC.md).
 */
export type BatchErrorCode =
  | "invalid_request"
  | "diarization_unavailable"
  | "unauthorized"
  | "insufficient_scope"
  | "idempotency_conflict"
  | "transcription_not_found"
  | "active_transcription_exists"
  | "recording_too_large"
  | "quota_exceeded"
  | "service_busy"
  | "service_paused"
  | "service_unavailable"
  | "upload_capability_limit"
  | "upload_capability_invalid"
  | "upload_capability_expired"
  | "upload_length_mismatch"
  | "unsupported_media_type"
  | "upload_in_progress"
  | "upload_interrupted"
  | "upload_rejected"
  | "transcript_expired"
  | "not_found"
  | "internal_error";

const TABLE: Record<BatchErrorCode, { status: number; type: string }> = {
  invalid_request: { status: 400, type: "invalid_request_error" },
  // `diarize: true` while this deployment has no diarization stage (capabilities report `diarization: false`).
  diarization_unavailable: { status: 400, type: "invalid_request_error" },
  unauthorized: { status: 401, type: "authentication_error" },
  insufficient_scope: { status: 403, type: "authentication_error" },
  idempotency_conflict: { status: 409, type: "invalid_request_error" },
  transcription_not_found: { status: 404, type: "not_found_error" },
  active_transcription_exists: { status: 409, type: "conflict_error" },
  recording_too_large: { status: 413, type: "invalid_request_error" },
  quota_exceeded: { status: 429, type: "rate_limit_error" },
  service_busy: { status: 429, type: "rate_limit_error" },
  service_paused: { status: 503, type: "service_error" },
  service_unavailable: { status: 503, type: "service_error" },
  upload_capability_limit: { status: 429, type: "rate_limit_error" },
  upload_capability_invalid: { status: 401, type: "authentication_error" },
  upload_capability_expired: { status: 410, type: "authentication_error" },
  upload_length_mismatch: { status: 400, type: "upload_error" },
  unsupported_media_type: { status: 415, type: "upload_error" },
  upload_in_progress: { status: 409, type: "upload_error" },
  upload_interrupted: { status: 408, type: "upload_error" },
  // The job itself failed during upload validation; `status` and `job_error` carry the terminal job code.
  upload_rejected: { status: 422, type: "upload_error" },
  transcript_expired: { status: 410, type: "not_found_error" },
  not_found: { status: 404, type: "not_found_error" },
  internal_error: { status: 500, type: "internal_error" },
};

export interface BatchErrorExtra {
  retry_after_seconds?: number;
  id?: string;
  status?: string;
  job_error?: { type: string; code: string; message: string };
}

export class BatchError extends Error {
  readonly status: number;
  readonly type: string;
  constructor(readonly code: BatchErrorCode, message: string, readonly extra: BatchErrorExtra = {}) {
    super(message);
    this.status = TABLE[code].status;
    this.type = TABLE[code].type;
  }
  toBody(correlationId: string) {
    return { error: { type: this.type, code: this.code, message: this.message, correlation_id: correlationId, ...this.extra } };
  }
}

export const batchErrorFor = (code: string): { status: number; type: string } | null =>
  Object.hasOwn(TABLE, code) ? TABLE[code as BatchErrorCode] : null;

/** Terminal job error codes (stored on the job, returned as `error` in status/result). */
export type JobErrorCode =
  | "upload_expired"
  | "upload_integrity_failed"
  | "invalid_audio"
  | "recording_too_long"
  | "unsupported_recording"
  | "no_speech"
  | "provider_unavailable"
  | "provider_outcome_unknown"
  | "processing_timeout"
  | "processing_failed"
  | "transcription_failed"
  | "cancelled";

const JOB_TYPE: Record<JobErrorCode, string> = {
  upload_expired: "upload_error",
  upload_integrity_failed: "upload_error",
  invalid_audio: "audio_error",
  recording_too_long: "audio_error",
  unsupported_recording: "audio_error",
  no_speech: "audio_error",
  provider_unavailable: "provider_error",
  provider_outcome_unknown: "provider_error",
  processing_timeout: "transcription_error",
  processing_failed: "transcription_error",
  transcription_failed: "transcription_error",
  cancelled: "cancelled",
};

export const jobError = (code: string | null, message: string | null) =>
  code ? { type: JOB_TYPE[code as JobErrorCode] ?? "transcription_error", code, message: message ?? code } : null;
