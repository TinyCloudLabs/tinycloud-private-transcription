import { describe, expect, test } from "bun:test";
import { captureObservation } from "../../src/domain/capture.ts";
import type { VexaTranscriptionResponse } from "../../src/providers/vexa/types.ts";

describe("capture diagnostics", () => {
  test.each(["browser_crashed", "browser_closed"])("retains %s without exposing free-form error text", (reason) => {
    const capture = captureObservation({
      id: 1, status: "failed", segments: [],
      data: { failure_stage: "active", last_error: { reason: `${reason}: private provider output`, exit_code: 1 } },
    } as unknown as VexaTranscriptionResponse);
    expect(capture.failure_reason).toBe(reason);
    expect(capture.completion_reason).toBeNull();
    expect(JSON.stringify(capture)).not.toContain("private provider output");
  });

  test("does not infer a browser crash from arbitrary error text or an exit code", () => {
    const capture = captureObservation({
      id: 1, status: "failed", segments: [],
      data: { last_error: { reason: "someone mentioned browser_crashed: in private output", exit_code: 137 } },
    } as unknown as VexaTranscriptionResponse);
    expect(capture.failure_reason).toBeUndefined();
  });
  test("retains operational evidence without copying private provider payloads", () => {
    const response = {
      id: 42, status: "failed", start_time: "2026-09-07T10:00:00Z", end_time: "2026-09-07T10:14:14Z",
      constructed_meeting_url: "https://private.invalid/secret", segments: [{ text: "private words" }],
      data: {
        completion_reason: "evicted", failure_stage: "active",
        last_error: { reason: "private error", error_details: "secret credential", exit_code: 137 },
        bot_logs: "private log",
        status_transition: [{ from: "active", to: "failed", timestamp: "2026-09-07T10:14:14Z", source: "bot_callback", completion_reason: "evicted", error_details: "private detail" }],
      },
    } as unknown as VexaTranscriptionResponse;
    const capture = captureObservation(response);
    expect(capture).toMatchObject({ completion_reason: "evicted", failure_stage: "active", exit_code: 137, transcript_segment_count: 1, audio_activity: "not_reported" });
    expect(capture.transitions).toEqual([{ from: "active", to: "failed", at: "2026-09-07T10:14:14.000Z", source: "bot_callback", completion_reason: "evicted" }]);
    expect(JSON.stringify(capture)).not.toMatch(/private|secret/);
  });

  test("missing audio telemetry and words do not become a silence verdict", () => {
    const capture = captureObservation({ id: 1, status: "completed", segments: [], start_time: null, end_time: null } as unknown as VexaTranscriptionResponse);
    expect(capture.completion_reason).toBeNull();
    expect(capture.exit_code).toBeNull();
    expect(capture.audio_activity).toBe("not_reported");
  });

  test("bounds the timeline and rejects free-form codes", () => {
    const capture = captureObservation({
      id: 1, status: "completed", segments: [], start_time: "bad timestamp", end_time: null,
      data: { completion_reason: "secret text", status_transition: Array.from({ length: 100 }, () => ({ from: null, to: "active", source: "private output", timestamp: "bad timestamp" })) },
    } as unknown as VexaTranscriptionResponse);
    expect(capture.transitions).toHaveLength(20);
    expect(capture.completion_reason).toBe("unknown");
    expect(capture.started_at).toBeNull();
    expect(JSON.stringify(capture)).not.toMatch(/secret|private/);
  });
});
