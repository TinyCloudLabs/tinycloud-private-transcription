import { describe, expect, test } from "bun:test";
import { mapVexaStatus, canTransition, clientStatus, isTerminal, mapVexaFailure } from "../../src/domain/state.ts";

describe("mapVexaStatus", () => {
  test("maps every vexa status with the flag on", () => {
    expect(mapVexaStatus("requested", true)).toBe("joining");
    expect(mapVexaStatus("joining", true)).toBe("joining");
    expect(mapVexaStatus("awaiting_admission", true)).toBe("waiting_for_admission");
    expect(mapVexaStatus("active", true)).toBe("in_progress");
    // Real lifecycle.v1 enum value (docs/vexa-findings.md): needs_help. needs_human_help kept as alias.
    expect(mapVexaStatus("needs_help", true)).toBe("needs_help");
    expect(mapVexaStatus("needs_human_help", true)).toBe("needs_help");
    expect(mapVexaStatus("stopping", true)).toBe("processing");
    expect(mapVexaStatus("completed", true)).toBe("processing");
    expect(mapVexaStatus("failed", true)).toBe("failed");
  });
  test("needs_help folds to waiting_for_admission when the flag is off", () => {
    expect(mapVexaStatus("needs_help", false)).toBe("waiting_for_admission");
    expect(mapVexaStatus("needs_human_help", false)).toBe("waiting_for_admission");
    expect(mapVexaStatus("active", false)).toBe("in_progress");
  });
  test("unknown status keeps us in joining (never throws)", () => {
    expect(mapVexaStatus("something_new", true)).toBe("joining");
    expect(mapVexaStatus("something_new", false)).toBe("joining");
  });
});

describe("clientStatus", () => {
  test("hides needs_help only while the flag is off", () => {
    expect(clientStatus("needs_help", false)).toBe("waiting_for_admission");
    expect(clientStatus("needs_help", true)).toBe("needs_help");
    expect(clientStatus("in_progress", false)).toBe("in_progress");
  });
});

describe("canTransition", () => {
  test("forward moves allowed", () => {
    expect(canTransition("queued", "joining")).toBe(true);
    expect(canTransition("joining", "waiting_for_admission")).toBe(true);
    expect(canTransition("waiting_for_admission", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "processing")).toBe(true);
    expect(canTransition("processing", "completed")).toBe(true);
    expect(canTransition("joining", "in_progress")).toBe(true);
    expect(canTransition("joining", "needs_help")).toBe(true);
    expect(canTransition("needs_help", "waiting_for_admission")).toBe(true);
    expect(canTransition("needs_help", "in_progress")).toBe(true);
  });
  test("no regressions", () => {
    expect(canTransition("in_progress", "joining")).toBe(false);
    expect(canTransition("needs_help", "joining")).toBe(false);
    expect(canTransition("processing", "in_progress")).toBe(false);
  });
  test("terminal states are sticky", () => {
    expect(canTransition("completed", "failed")).toBe(false);
    expect(canTransition("failed", "processing")).toBe(false);
    expect(canTransition("cancelled", "joining")).toBe(false);
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("in_progress")).toBe(false);
  });
  test("failure from any non-terminal", () => {
    expect(canTransition("queued", "failed")).toBe(true);
    expect(canTransition("processing", "failed")).toBe(true);
  });
  test("cancel only before admission", () => {
    expect(canTransition("queued", "cancelled")).toBe(true);
    expect(canTransition("in_progress", "cancelled")).toBe(false);
  });
});

describe("mapVexaFailure", () => {
  test("maps completion reasons to our codes and never leaks raw", () => {
    expect(mapVexaFailure("awaiting_admission_timeout").code).toBe("waiting_room_timeout");
    expect(mapVexaFailure("awaiting_admission_rejected").code).toBe("meeting_join_failed");
    expect(mapVexaFailure("evicted").code).toBe("bot_removed");
    expect(mapVexaFailure("join_failure").code).toBe("meeting_join_failed");
    expect(mapVexaFailure("left_alone").code).toBe("meeting_ended");
    expect(mapVexaFailure("stopped_with_no_audio").code).toBe("capture_failed");
    const unknown = mapVexaFailure("some raw vexa detail");
    expect(unknown.code).toBe("capture_failed");
    expect(unknown.message).not.toContain("raw vexa");
  });
});
