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
  expect(t.segments[2]).toMatchObject({ speaker_id: null, speaker_name: null, attribution: "unknown" });
  expect(t.text).toBe("Sam: Hello there.\nBob: Second.\nUnknown voice");
});

test("capture identities survive duplicate display names and name changes; uncertainty is retained", () => {
  const t = normalizeSegments([
    { start: 0, end: 1, text: "First", speaker: "Sam", speakerKey: "a", attribution: "identified" },
    { start: 1, end: 2, text: "Second", speaker: "Sam", speakerKey: "b", attribution: "identified" },
    { start: 2, end: 3, text: "Renamed", speaker: "Samuel", speakerKey: "a", attribution: "identified" },
    { start: 3, end: 4, text: "Both", speaker: null, attribution: "overlap" },
  ]);
  expect(t.segments.map(s => s.speaker_id)).toEqual(["speaker_0", "speaker_1", "speaker_0", null]);
  expect(t.segments[2]?.speaker_name).toBe("Samuel");
  expect(t.segments[3]).toMatchObject({ speaker_name: null, attribution: "overlap" });
});

test("missing, null and blank names create no participant, even with distinct unresolved keys (TC-981)", () => {
  const t = normalizeSegments([
    { start: 0, end: 1, text: " First " },
    { start: 1, end: 2, text: "Second", speaker: null, speakerKey: "unresolved:a", attribution: "unknown" },
    { start: 2, end: 3, text: "Third", speaker: " \t ", speakerKey: "unresolved:b", attribution: "identified" },
    { start: 3, end: 4, text: "Named", speaker: " Alice " },
  ]);
  expect(t.speakers).toEqual([{ id: "speaker_0", name: "Alice" }]);
  for (const segment of t.segments.slice(0, 3)) {
    expect(segment).toMatchObject({ speaker_id: null, speaker_name: null, attribution: "unknown" });
  }
  expect(t.text).toBe("First\nSecond\nThird\nAlice: Named");
});

test("a participant actually named Unknown keeps their name (TC-981)", () => {
  const t = normalizeSegments([{ start: 0, end: 1, text: "Hello", speaker: "Unknown", attribution: "identified" }]);
  expect(t.speakers).toEqual([{ id: "speaker_0", name: "Unknown" }]);
  expect(t.segments[0]).toMatchObject({ speaker_name: "Unknown", attribution: "identified" });
  expect(t.text).toBe("Unknown: Hello");
});
