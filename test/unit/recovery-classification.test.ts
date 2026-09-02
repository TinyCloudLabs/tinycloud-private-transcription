/**
 * A1 recovery taxonomy: classification is a pure function of the stored status and exact safe
 * failure code, and it fails
 * closed. Anything the state machine does not name — a status from a newer writer, an empty
 * string, or an inherited Object.prototype key — must classify as not_recoverable rather than
 * as something the recover endpoint would act on.
 */
import { expect, test } from "bun:test";
import {
  authoritativeRecoveryDeadline,
  clampRecoveryWakeToDeadline,
  classifyRecovery,
} from "../../src/domain/recovery.ts";
import type { MeetingStatus } from "../../src/domain/state.ts";

test("every meeting status maps to exactly one recovery classification", () => {
  const expected: Record<MeetingStatus, string> = {
    queued: "not_recoverable",
    joining: "not_recoverable",
    waiting_for_admission: "not_recoverable",
    in_progress: "not_recoverable",
    processing: "already_active",
    completed: "already_completed",
    failed: "not_recoverable",
    cancelled: "not_recoverable",
  };
  for (const [status, classification] of Object.entries(expected)) {
    expect(classifyRecovery(status)).toBe(classification as never);
  }
});

test("unrecognized statuses fail closed instead of becoming eligible", () => {
  // "__proto__"/"toString"/"constructor" are the fail-open trap: a plain object lookup table
  // answers those from Object.prototype, which would smuggle a truthy value past the guard.
  for (const status of ["", " ", "FAILED", "Failed", "recovering", "unknown", "__proto__", "toString", "constructor", "hasOwnProperty"]) {
    expect(classifyRecovery(status)).toBe("not_recoverable");
  }
});

test("only exact allowlisted transient failure codes are potentially eligible", () => {
  for (const code of ["provider_timeout", "provider_unavailable", "finalizer_interrupted"]) {
    expect(classifyRecovery("failed", code)).toBe("eligible");
  }

  for (const code of [
    null,
    "",
    "transcription_failed",
    "recording_fetch_transient",
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
    "invalid_request",
    "unauthorized",
    "unknown_failure",
    "__proto__",
  ]) {
    expect(classifyRecovery("failed", code)).toBe("not_recoverable");
  }
});

test("persisted deadlines are immutable wake bounds and nullable legacy rows fail closed at acceptance", () => {
  const acceptedAt = new Date("2026-09-02T00:00:00.000Z");
  const deadlineAt = new Date("2026-09-02T00:01:00.000Z");
  expect(authoritativeRecoveryDeadline({ acceptedAt, deadlineAt })).toBe(deadlineAt);
  expect(authoritativeRecoveryDeadline({ acceptedAt, deadlineAt: null })).toBe(acceptedAt);
  expect(clampRecoveryWakeToDeadline(
    { acceptedAt, deadlineAt },
    new Date("2026-09-02T00:02:00.000Z"),
  )).toBe(deadlineAt);
});
