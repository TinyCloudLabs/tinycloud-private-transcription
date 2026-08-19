import { describe, expect, test } from "bun:test";
import { mapVexaStatus, canTransition, isTerminal, mapVexaFailure } from "../../src/domain/state.ts";

describe("mapVexaStatus", () => {
  test("maps every vexa status", () => {
    expect(mapVexaStatus("requested")).toBe("joining");
    expect(mapVexaStatus("joining")).toBe("joining");
    expect(mapVexaStatus("awaiting_admission")).toBe("waiting_for_admission");
    expect(mapVexaStatus("active")).toBe("in_progress");
    expect(mapVexaStatus("needs_human_help")).toBe("waiting_for_admission");
    expect(mapVexaStatus("stopping")).toBe("processing");
    expect(mapVexaStatus("completed")).toBe("processing");
    expect(mapVexaStatus("failed")).toBe("failed");
  });
  test("unknown status keeps us in joining (never throws)", () => {
    expect(mapVexaStatus("something_new")).toBe("joining");
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
  });
  test("no regressions", () => {
    expect(canTransition("in_progress", "joining")).toBe(false);
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
