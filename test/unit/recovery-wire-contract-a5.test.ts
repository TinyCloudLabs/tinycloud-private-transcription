import { expect, test } from "bun:test";
import {
  RECOVERY_DISPOSITIONS,
  RECOVERY_PHASES,
  RECOVERY_SUPPORTED_ERROR_CODES,
  serializeRecoveryCapabilities,
  serializeRecoverResponse,
  type RecoveryCapabilitiesResponse,
  type RecoverMeetingResponse,
} from "../../src/api/recovery-contract.ts";

test("A5 exports one bounded recovery wire vocabulary and deterministic capability serializer", () => {
  expect(RECOVERY_DISPOSITIONS).toEqual(["started", "already_active", "already_completed"]);
  expect(RECOVERY_PHASES).toEqual([
    "queued", "preflighting", "chunking", "transcribing", "delayed", "publishing", "completed", "failed", "disabled",
  ]);
  expect(RECOVERY_SUPPORTED_ERROR_CODES).toEqual([
    "provider_timeout", "provider_unavailable", "finalizer_interrupted", "recording_fetch_transient",
  ]);
  const dark: RecoveryCapabilitiesResponse = serializeRecoveryCapabilities("../../operator-secret", false);
  expect(dark).toEqual({
    recovery: {
      contract_version: null,
      manual_available: false,
      automatic_available: false,
      supported_error_codes: RECOVERY_SUPPORTED_ERROR_CODES,
    },
  });
  expect(serializeRecoveryCapabilities("recovery-v2", true).recovery.contract_version).toBe("recovery-v2");
});

test("A5 recover serializer never invents operation metadata", () => {
  const started: RecoverMeetingResponse = serializeRecoverResponse({
    meetingId: "mtg_0000000000000000000000000A",
    status: "processing",
    disposition: "started",
    operation: { id: "rcv_0000000000000000000000000A", phase: "queued", ordinal: 1 },
  });
  expect(started).toEqual({
    id: "mtg_0000000000000000000000000A",
    status: "processing",
    recovery: {
      operation_id: "rcv_0000000000000000000000000A",
      disposition: "started",
      kind: "manual",
      phase: "queued",
      attempt: 1,
      max_attempts: 1,
      next_eligible_at: null,
    },
  });
  expect(serializeRecoverResponse({
    meetingId: "mtg_0000000000000000000000000A",
    status: "completed",
    disposition: "already_completed",
    operation: null,
  }).recovery).toEqual({
    operation_id: null,
    disposition: "already_completed",
    kind: "manual",
    phase: null,
    attempt: null,
    max_attempts: null,
    next_eligible_at: null,
  });
  expect(() => serializeRecoverResponse({
    meetingId: "mtg_0000000000000000000000000A",
    status: "processing",
    disposition: "started",
    operation: { id: "PROVIDER_BODY_SENTINEL", phase: "queued", ordinal: 1 },
  })).toThrow("invalid recovery operation wire state");
  expect(() => serializeRecoverResponse({
    meetingId: "invalid-meeting-id",
    status: "processing",
    disposition: "started",
    operation: { id: "rcv_0000000000000000000000000A", phase: "queued", ordinal: 1 },
  })).toThrow("invalid recovery meeting identifier");
  expect(serializeRecoverResponse({
    meetingId: "mtg_0000000000000000000000000A",
    status: "processing",
    disposition: "started",
    operation: { id: "rcv_0000000000000000000000000A", phase: "queued", ordinal: 1 },
    nextEligibleAt: new Date("2026-01-01T00:00:00.000Z"),
  }).recovery.next_eligible_at).toBeNull();
  expect(serializeRecoverResponse({
    meetingId: "mtg_0000000000000000000000000A",
    status: "processing",
    disposition: "started",
    operation: { id: "rcv_0000000000000000000000000A", phase: "queued", ordinal: 2 },
  }).recovery).toMatchObject({ attempt: 1, max_attempts: 1 });
});
