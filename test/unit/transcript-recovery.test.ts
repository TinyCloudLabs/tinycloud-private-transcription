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
  test("empty output attempts recovery even without trustworthy duration evidence", () => {
    expect(isMateriallyIncomplete(response(null), [])).toBe(true);
  });

  test("recovers an empty native transcript even for a short call", () => {
    expect(isMateriallyIncomplete(response(10), [])).toBe(true);
    expect(isMateriallyIncomplete(response(10), [segment(2)])).toBe(false);
  });

  test("preserves a materially covered native tail and recovers a materially missing one", () => {
    expect(isMateriallyIncomplete(response(120), [segment(110)])).toBe(false);
    expect(isMateriallyIncomplete(response(120), [segment(20)])).toBe(true);
    expect(isMateriallyIncomplete(response(120), [])).toBe(true);
  });

  test("detects a materially large internal gap even when the late tail is present", () => {
    expect(isMateriallyIncomplete(response(120), [segment(20), { ...segment(120), start: 118 }])).toBe(true);
  });
});
