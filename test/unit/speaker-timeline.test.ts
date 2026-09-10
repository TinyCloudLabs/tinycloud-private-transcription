import { expect, test } from "bun:test";
import { partitionSpeakerTimeline, type SpeakerInterval } from "../../src/providers/transcription/speaker-timeline.ts";

const named = (start: number, end: number, participantId: string, name = participantId): SpeakerInterval =>
  ({ start, end, participantId, name, attribution: "identified" });

test("recording coverage survives missing speaker metadata, gaps, and subsecond turns", () => {
  const parts = partitionSpeakerTimeline(10, [named(2, 4, "alice"), named(4, 4.1, "bob"), named(7, 9, "alice")]);
  expect(parts.map(p => [p.start, p.end, p.attribution, p.participantId])).toEqual([
    [0, 2, "unknown", null], [2, 4, "identified", "alice"], [4, 4.1, "identified", "bob"],
    [4.1, 7, "unknown", null], [7, 9, "identified", "alice"], [9, 10, "unknown", null],
  ]);
  expect(partitionSpeakerTimeline(10, [])).toEqual([
    { start: 0, end: 10, participantId: null, name: null, attribution: "unknown" },
  ]);
});

test("overlap is transcribed once and remains uncertain even when one participant dominates", () => {
  const parts = partitionSpeakerTimeline(10, [named(0, 10, "alice"), named(4, 5, "bob")]);
  expect(parts).toEqual([
    named(0, 4, "alice"),
    { start: 4, end: 5, participantId: null, name: null, attribution: "overlap" },
    named(5, 10, "alice"),
  ]);
});

test("duplicate chunks merge by participant identity; identical display names do not merge people", () => {
  const parts = partitionSpeakerTimeline(6, [named(0, 3, "a", "Sam"), named(1, 3, "a", "Sam"), named(3, 6, "b", "Sam")]);
  expect(parts).toEqual([named(0, 3, "a", "Sam"), named(3, 6, "b", "Sam")]);
  const renamed = partitionSpeakerTimeline(6, [named(0, 4, "a", "Sam"), named(3, 6, "a", "Samuel")]);
  expect(renamed.map(p => p.attribution)).toEqual(["identified", "unknown", "identified"]);
});

test("unknown and explicit overlap evidence never inherit a nearby participant's name", () => {
  const uncertain: SpeakerInterval = { start: 2, end: 3, participantId: null, name: null, attribution: "unknown" };
  expect(partitionSpeakerTimeline(4, [named(0, 4, "a"), uncertain]).map(p => p.attribution))
    .toEqual(["identified", "unknown", "identified"]);
  expect(partitionSpeakerTimeline(4, [{ ...uncertain, start: 0, end: 4, attribution: "overlap" }])[0]?.attribution)
    .toBe("overlap");
});

test("out-of-range times clip to the audio; invalid metadata fails closed without inventing identities", () => {
  expect(partitionSpeakerTimeline(4, [named(-2, 2, "a"), named(2, 8, "b")]))
    .toEqual([named(0, 2, "a"), named(2, 4, "b")]);
  expect(() => partitionSpeakerTimeline(4, [named(NaN, 2, "a")])).toThrow();
  expect(() => partitionSpeakerTimeline(4, [named(3, 2, "a")])).toThrow();
  expect(() => partitionSpeakerTimeline(Infinity, [])).toThrow();
  expect(() => partitionSpeakerTimeline(4, [named(0, 2, "")])).toThrow();
  expect(() => partitionSpeakerTimeline(4, [named(0, 2, "a")], { maxIntervals: 0 })).toThrow();
});

test("a synthetic hour with late joins, overlap and dropped metadata covers every instant exactly once", () => {
  const intervals: SpeakerInterval[] = [];
  for (let t = 0; t < 3600; t += 5) {
    if (t % 35 === 0) continue; // lost metadata must not delete the recording window
    intervals.push(named(t, t + 5, String(t % 3)));
    if (t > 600 && t % 20 === 0) intervals.push(named(t + 1, t + 2, "late"));
  }
  const parts = partitionSpeakerTimeline(3600, intervals);
  expect(parts[0]?.start).toBe(0);
  expect(parts.at(-1)?.end).toBe(3600);
  expect(parts.reduce((n, p) => n + p.end - p.start, 0)).toBe(3600);
  for (let i = 1; i < parts.length; i++) expect(parts[i]!.start).toBe(parts[i - 1]!.end);
  // Independent half-second oracle: each known, unknown and overlapping input window is represented.
  for (let t = 0.25; t < 3600; t += 0.5) {
    const active = intervals.filter(p => p.start <= t && p.end > t);
    const output = parts.filter(p => p.start <= t && p.end > t);
    expect(output).toHaveLength(1);
    const ids = new Set(active.map(p => p.participantId));
    expect(output[0]!.attribution).toBe(ids.size === 0 ? "unknown" : ids.size === 1 ? "identified" : "overlap");
  }
});
