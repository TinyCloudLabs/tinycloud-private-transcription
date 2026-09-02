/**
 * A1 safe error envelope: every rejection answers `{error:{type,code,message,retryable},request_id}`.
 * `retryable` is a fail-closed taxonomy (only known-transient provider faults are true) so a
 * deterministic refusal such as a 503 switch-off never invites a client retry storm, and
 * `request_id` is minted by us — never echoed from the request — so it cannot carry caller input
 * into logs or into another client's response.
 */
import { expect, test } from "bun:test";
import { createApp } from "../../src/api/app.ts";
import type { AppContext } from "../../src/context.ts";
import { ApiError, isRetryableErrorCode, type ErrorCode } from "../../src/domain/errors.ts";
import { newRequestId } from "../../src/domain/ids.ts";
import type { Logger } from "../../src/log.ts";

const ALL_CODES: ErrorCode[] = [
  "invalid_meeting_url",
  "unsupported_platform",
  "meeting_not_found",
  "meeting_join_failed",
  "waiting_room_timeout",
  "bot_removed",
  "meeting_ended",
  "capture_failed",
  "transcription_failed",
  "provider_timeout",
  "provider_unavailable",
  "provider_rejected",
  "finalizer_interrupted",
  "recording_fetch_transient",
  "recording_absent",
  "recording_undecodable",
  "recording_silent",
  "attestation_failed",
  "coverage_incomplete",
  "budget_exhausted",
  "persistence_failed",
  "cancelled",
  "deleted",
  "validation_failed",
  "authentication_failed",
  "internal_error",
  "unauthorized",
  "insufficient_scope",
  "invalid_request",
  "idempotency_conflict",
  "recovery_disabled",
  "recovery_ineligible",
  "recovery_cooldown",
  "not_found",
];

test("only known-transient provider faults are retryable", () => {
  const retryable = ALL_CODES.filter(isRetryableErrorCode);
  expect(retryable.sort()).toEqual(["provider_timeout", "provider_unavailable"]);
  // A deterministic refusal is not retryable even though it is served as a 5xx.
  expect(isRetryableErrorCode("recovery_disabled")).toBe(false);
  expect(isRetryableErrorCode("internal_error")).toBe(false);
});

test("an unknown code fails closed to not-retryable", () => {
  expect(isRetryableErrorCode("no_such_code" as ErrorCode)).toBe(false);
  expect(isRetryableErrorCode("toString" as ErrorCode)).toBe(false);
  expect(isRetryableErrorCode("__proto__" as ErrorCode)).toBe(false);
});

test("toBody emits exactly the safe envelope and echoes the supplied request id", () => {
  const body = new ApiError("recovery_disabled", "Meeting recovery is not available on this deployment.").toBody("req_test");
  expect(body).toEqual({
    error: { type: "internal_error", code: "recovery_disabled", message: "Meeting recovery is not available on this deployment.", retryable: false },
    request_id: "req_test",
  });
  expect(Object.keys(body)).toEqual(["error", "request_id"]);
  expect(Object.keys(body.error)).toEqual(["type", "code", "message", "retryable"]);
});

test("insufficient_scope is a 403 permission error", () => {
  const err = new ApiError("insufficient_scope", "This API key is not permitted to perform this action.");
  expect(err.status).toBe(403);
  expect(err.toBody("req_test").error).toEqual({
    type: "permission_error",
    code: "insufficient_scope",
    message: "This API key is not permitted to perform this action.",
    retryable: false,
  });
});

test("recovery error codes use the safe plan status mapping", () => {
  expect(new ApiError("provider_timeout", "safe").status).toBe(503);
  expect(new ApiError("provider_unavailable", "safe").status).toBe(503);
  expect(new ApiError("recording_fetch_transient", "safe").status).toBe(503);
  expect(new ApiError("persistence_failed", "safe").status).toBe(503);
  expect(new ApiError("recording_absent", "safe").status).toBe(410);
  expect(new ApiError("budget_exhausted", "safe").status).toBe(429);
  expect(new ApiError("recovery_cooldown", "safe").status).toBe(429);
  for (const code of [
    "recovery_ineligible",
    "provider_rejected",
    "recording_undecodable",
    "recording_silent",
    "attestation_failed",
    "coverage_incomplete",
    "cancelled",
  ] as const) {
    expect(new ApiError(code, "safe").status).toBe(409);
  }
});

test("Retry-After metadata is accepted only as a bounded positive whole second value", () => {
  expect(new ApiError("recovery_cooldown", "safe", 429, 1).retryAfterSeconds).toBe(1);
  expect(new ApiError("recovery_cooldown", "safe", 429, 86_400).retryAfterSeconds).toBe(86_400);
  for (const invalid of [0, -1, 1.5, 86_401, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(new ApiError("recovery_cooldown", "safe", 429, invalid).retryAfterSeconds).toBeNull();
  }
});

test("request ids are minted locally and are opaque", () => {
  const id = newRequestId();
  expect(id).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(newRequestId()).not.toBe(id);
});

test("unhandled errors log only locally authored bounded fields and return no raw sentinels", async () => {
  const sentinels = {
    path: "mtg_PATH_SENTINEL",
    url: "https://provider.invalid/URL_SENTINEL",
    project: "project_IDENTIFIER_SENTINEL",
    providerBody: "PROVIDER_BODY_SENTINEL",
    secret: "sk_SECRET_TOKEN_SENTINEL",
    message: "EXCEPTION_MESSAGE_SENTINEL",
    stack: "EXCEPTION_STACK_SENTINEL",
    correlation: "CALLER_CORRELATION_SENTINEL",
  };
  const entries: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  const capture = (level: string) => (msg: string, data?: Record<string, unknown>) => entries.push({ level, msg, data });
  const log: Logger = {
    debug: capture("debug"),
    info: capture("info"),
    warn: capture("warn"),
    error: capture("error"),
  };
  const failure = new Error(
    `${sentinels.message} ${sentinels.url} ${sentinels.project} ${sentinels.providerBody} ${sentinels.secret}`,
  );
  failure.stack = sentinels.stack;
  const ctx = {
    log,
    db: {
      select() {
        throw failure;
      },
    },
  } as unknown as AppContext;

  const response = await createApp(ctx).request(`http://local.test/v1/meetings/${sentinels.path}`, {
    headers: {
      Authorization: `Bearer tc_live_${sentinels.secret}`,
      "X-Request-Id": sentinels.correlation,
      "X-Correlation-Id": sentinels.correlation,
    },
  });
  const body = (await response.json()) as {
    error: { type: string; code: string; message: string; retryable: boolean };
    request_id: string;
  };
  expect(response.status).toBe(500);
  expect(body).toEqual({
    error: { type: "internal_error", code: "internal_error", message: "An internal error occurred", retryable: false },
    request_id: expect.stringMatching(/^req_[0-9A-HJKMNP-TV-Z]{26}$/),
  });
  expect(entries).toEqual([
    {
      level: "error",
      msg: "request_failed",
      data: { requestId: body.request_id, errorClass: "unhandled_error" },
    },
  ]);

  const serialized = JSON.stringify({ body, entries });
  for (const sentinel of Object.values(sentinels)) expect(serialized).not.toContain(sentinel);
});
