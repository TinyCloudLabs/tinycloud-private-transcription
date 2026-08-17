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
  | "internal_error"
  // request-level codes
  | "unauthorized"
  | "invalid_request"
  | "idempotency_conflict";

export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
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
  meeting_not_found: "not_found_error",
  meeting_join_failed: "meeting_join_failed",
  waiting_room_timeout: "meeting_join_failed",
  bot_removed: "capture_error",
  meeting_ended: "capture_error",
  capture_failed: "capture_error",
  transcription_failed: "transcription_error",
  provider_timeout: "provider_error",
  provider_unavailable: "provider_error",
  internal_error: "internal_error",
};

const CODE_STATUS: Partial<Record<ErrorCode, number>> = {
  invalid_meeting_url: 400,
  unsupported_platform: 400,
  invalid_request: 400,
  unauthorized: 401,
  meeting_not_found: 404,
  idempotency_conflict: 409,
  provider_unavailable: 503,
  provider_timeout: 504,
};

export class ApiError extends Error {
  readonly type: ErrorType;
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    status?: number,
  ) {
    super(message);
    this.type = CODE_TYPE[code];
    this.status = status ?? CODE_STATUS[code] ?? 500;
  }
  toBody() {
    return { error: { type: this.type, code: this.code, message: this.message } };
  }
}

export const errorTypeFor = (code: ErrorCode): ErrorType => CODE_TYPE[code];
