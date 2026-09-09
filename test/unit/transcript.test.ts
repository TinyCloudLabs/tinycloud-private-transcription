import { expect, test } from "bun:test";
import { normalizeSegments } from "../../src/domain/transcript.ts";

test("normalizeSegments builds stable speaker ids, text, duration", () => {
  const t = normalizeSegments(
    [
      { start: 3.0, end: 4.5, text: "Second.", speaker: "Bob", language: "en" },
      { start: 0.0, end: 2.5, text: "Hello there.", speaker: "Sam", language: "en" },
      { start: 5.0, end: 6.0, text: "  ", speaker: "Sam", language: "en" },
      { start: 6.0, end: 7.0, text: "Unknown voice", speaker: null, language: null },
    ],
    "en",
  );
  expect(t.language).toBe("en");
  expect(t.duration_seconds).toBe(7);
  expect(t.speakers).toEqual([
    { id: "speaker_0", name: "Sam" },
    { id: "speaker_1", name: "Bob" },
    { id: "speaker_2", name: "Unknown" },
  ]);
  expect(t.segments.map((s) => s.id)).toEqual(["seg_001", "seg_002", "seg_003"]);
  expect(t.segments[0]).toEqual({
    id: "seg_001",
    speaker_id: "speaker_0",
    speaker_name: "Sam",
    start: 0,
    end: 2.5,
    text: "Hello there.",
  });
  expect(t.text).toBe("Sam: Hello there.\nBob: Second.\nUnknown: Unknown voice");
});

test("capture identities survive duplicate display names and name changes; uncertainty is retained", () => {
  const t = normalizeSegments([
    { start: 0, end: 1, text: "First", speaker: "Sam", speakerKey: "a", attribution: "identified" },
    { start: 1, end: 2, text: "Second", speaker: "Sam", speakerKey: "b", attribution: "identified" },
    { start: 2, end: 3, text: "Renamed", speaker: "Samuel", speakerKey: "a", attribution: "identified" },
    { start: 3, end: 4, text: "Both", speaker: null, attribution: "overlap" },
  ]);
  expect(t.segments.map(s => s.speaker_id)).toEqual(["speaker_0", "speaker_1", "speaker_0", "speaker_2"]);
  expect(t.segments[2]?.speaker_name).toBe("Samuel");
  expect(t.segments[3]).toMatchObject({ speaker_name: "Unknown", attribution: "overlap" });
});
