import { describe, expect, test } from "bun:test";
import { isMateriallyIncomplete } from "../../src/worker/meeting-job.ts";
import type { VexaTranscriptionResponse, VexaTranscriptionSegment } from "../../src/providers/vexa/types.ts";

const response = (durationSeconds: number | null): VexaTranscriptionResponse => ({
  id: 1,
  platform: "jitsi",
  native_meeting_id: "room@jitsi.local",
  constructed_meeting_url: "https://jitsi.local/room",
  status: "completed",
  start_time: durationSeconds === null ? null : "2026-09-18T10:00:00.000Z",
  end_time: durationSeconds === null ? null : new Date(Date.parse("2026-09-18T10:00:00.000Z") + durationSeconds * 1000).toISOString(),
  segments: [],
});

const segment = (end: number): VexaTranscriptionSegment => ({
  start: 0,
  end,
  text: "Native words",
  language: "en",
  speaker: "Alice",
  completed: true,
});

describe("Vexa terminal timeline coverage", () => {
  test("requires duration evidence before selecting recording recovery", () => {
    expect(isMateriallyIncomplete(response(null), [])).toBe(false);
  });

  test("does not misclassify a short terminal meeting, even when it has no words", () => {
    expect(isMateriallyIncomplete(response(10), [])).toBe(false);
    expect(isMateriallyIncomplete(response(10), [segment(2)])).toBe(false);
  });

  test("preserves a materially covered native tail and recovers a materially missing one", () => {
    expect(isMateriallyIncomplete(response(120), [segment(110)])).toBe(false);
    expect(isMateriallyIncomplete(response(120), [segment(20)])).toBe(true);
    expect(isMateriallyIncomplete(response(120), [])).toBe(true);
  });
});
