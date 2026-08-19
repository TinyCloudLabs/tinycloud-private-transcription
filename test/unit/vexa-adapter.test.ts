import { expect, test } from "bun:test";
import { adaptVexaSegments, completionReasonOf, dedupeVexaSegments, toMeetingRelative } from "../../src/providers/vexa/adapter.ts";
import sample from "../../docs/vexa-samples/vexa-transcript.json";
import type { VexaTranscriptionResponse } from "../../src/providers/vexa/types.ts";

const real = sample as unknown as VexaTranscriptionResponse;

test("real capture-rig transcript → meeting-relative, speaker-attributed segments", () => {
  const segs = adaptVexaSegments(real);
  expect(segs).toHaveLength(2);
  // start_time 17:13:31.012, first segment 17:13:34.905 → 3.893 s into the meeting
  expect(segs[0]).toMatchObject({ start: 3.893, end: 8.893, speaker: "Alice", text: "The quick brown fox jumps over the lazy dog.", segment_id: "turn:0:0" });
  expect(segs[1]).toMatchObject({ start: 8.893, end: 10.893, speaker: "Alice", text: "Hello from Alice.", segment_id: "turn:0:1" });
  expect(completionReasonOf(real)).toBe("stopped");
});

test("dedupe: drafts (turn:N:pX) dropped when the turn has confirmed rows; multiple confirmed rows per turn kept; upsert by id", () => {
  const segs = dedupeVexaSegments([
    { start: 10, end: 12, text: "the quick brown fax", language: "en", speaker: "Alice", completed: true, segment_id: "turn:6:p0" },
    { start: 10, end: 14, text: "The quick brown fox jumps over the lazy dog.", language: "en", speaker: "Alice", completed: true, segment_id: "turn:6:0" },
    { start: 14, end: 15, text: "Hello", language: "en", speaker: "Alice", completed: true, segment_id: "turn:6:1" },
    { start: 14, end: 15, text: "Hello from Alice.", language: "en", speaker: "Alice", completed: true, segment_id: "turn:6:1" },
    { start: 20, end: 21, text: "still talking", language: "en", speaker: "Bob", completed: true, segment_id: "turn:7:p0" },
    { start: 22, end: 23, text: "live draft", language: "en", speaker: "Bob", completed: false, source: "merged", segment_id: "turn:8:p0" },
    { start: 0, end: 1, text: "legacy no id", language: "en", speaker: "Sam", completed: true },
  ]);
  expect(segs.map((s) => [s.segment_id ?? null, s.text])).toEqual([
    [null, "legacy no id"],
    ["turn:6:0", "The quick brown fox jumps over the lazy dog."],
    ["turn:6:1", "Hello from Alice."],
    ["turn:7:p0", "still talking"], // only draft of its turn → kept
  ]);
});

test("toMeetingRelative: start_time origin when it precedes the first segment, else first segment; relative passthrough", () => {
  const epoch = Date.parse("2026-08-17T17:13:31.012Z") / 1000;
  const r = toMeetingRelative([{ start: epoch + 5.5, end: epoch + 7, text: "x", language: "en" }], "2026-08-17T17:13:31.012Z");
  expect(r[0]).toMatchObject({ start: 5.5, end: 7 });
  const noStart = toMeetingRelative([{ start: epoch + 5.5, end: epoch + 7, text: "x", language: "en" }], null);
  expect(noStart[0]).toMatchObject({ start: 0, end: 1.5 });
  const rel = toMeetingRelative([{ start: 0, end: 3.2, text: "x", language: "en" }, { start: 3.5, end: 5, text: "y", language: "en" }], null);
  expect(rel.map((s) => [s.start, s.end])).toEqual([[0, 3.2], [3.5, 5]]);
});
