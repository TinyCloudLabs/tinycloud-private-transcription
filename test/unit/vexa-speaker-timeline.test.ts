import { expect, test } from "bun:test";
import { adaptSpeakerTimeline } from "../../src/providers/vexa/speaker-timeline.ts";

const payload = { version: 1, recording_id: 42, recording_started_at_ms: 1800000000000, capped: false,
  intervals: [{ start_ms: 250, end_ms: 1000, participant_id: "a", name: "Alice", attribution: "identified" }] };

test("recording offsets remain relative and are bound to the exact recording", () => {
  expect(adaptSpeakerTimeline(payload, 42)).toEqual([{ start: 0.25, end: 1, participantId: "a", name: "Alice", attribution: "identified" }]);
  expect(() => adaptSpeakerTimeline(payload, 43)).toThrow();
  expect(() => adaptSpeakerTimeline({ ...payload, recording_started_at_ms: 0 }, 42)).toThrow();
});

test("unknown metadata cannot smuggle a participant attribution", () => {
  expect(adaptSpeakerTimeline({ ...payload, intervals: [{ ...payload.intervals[0], attribution: "overlap" }] }, 42)[0])
    .toMatchObject({ participantId: null, name: null, attribution: "overlap" });
  expect(() => adaptSpeakerTimeline({ ...payload, intervals: [{ ...payload.intervals[0], start_ms: NaN }] }, 42)).toThrow();
});
