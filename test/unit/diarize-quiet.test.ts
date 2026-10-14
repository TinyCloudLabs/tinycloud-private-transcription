import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDiarizedSpeech, speakerTurns, unionQuietTurns, UNKNOWN_SPEAKER, type Turn } from "../../src/uploads/diarize.ts";
import { detectSpeech, frameEnergies, summarizeVad, VAD, type Region } from "../../src/uploads/vad.ts";
import { pcmFromLevels, quietSpeechLevels } from "../support/vad-fixtures.ts";

let dir: string;
let quietPcm: Float64Array;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ptx-diarize-quiet-"));
  const path = join(dir, "quiet.pcm");
  await Bun.write(path, pcmFromLevels(quietSpeechLevels()));
  quietPcm = await frameEnergies(path);
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
const sentMs = (regions: readonly Region[]) => regions.reduce((sum, r) => sum + r.endMs - r.startMs, 0);
function includes(regions: readonly Region[], original: readonly Region[]) {
  for (const r of original) {
    let end = r.startMs;
    for (const next of regions) if (next.startMs <= end && next.endMs > end) end = next.endMs;
    expect(end).toBeGreaterThanOrEqual(r.endMs);
  }
}
function disjointAndCapped(turns: readonly Turn[]) {
  for (const [i, turn] of turns.entries()) {
    expect(turn.endMs).toBeGreaterThan(turn.startMs);
    expect(turn.endMs - turn.startMs).toBeLessThanOrEqual(30_000);
    if (i > 0) expect(turn.startMs).toBeGreaterThanOrEqual(turns[i - 1]!.endMs);
  }
}

test("quiet PCM sends the exact union, retaining diarizer-only audio and computing stats on final coverage", () => {
  const segments = [{ startMs: 12_000, endMs: 13_000, speaker: 7 }, { startMs: 70_000, endMs: 70_500, speaker: 3 }];
  const original = speakerTurns(segments, quietPcm), quiet = detectSpeech(quietPcm);
  const result = detectDiarizedSpeech(segments, quietPcm);
  expect(result.turns).toEqual([
    { startMs: 9_500, endMs: 11_750, speaker: UNKNOWN_SPEAKER }, { startMs: 11_750, endMs: 13_250, speaker: 7 },
    { startMs: 13_250, endMs: 20_500, speaker: UNKNOWN_SPEAKER }, { startMs: 39_500, endMs: 50_500, speaker: UNKNOWN_SPEAKER },
    { startMs: 69_750, endMs: 70_750, speaker: 3 },
  ]);
  includes(result.turns, original); includes(result.turns, quiet.regions); disjointAndCapped(result.turns);
  expect(sentMs(result.turns)).toBe(23_000);
  expect(result.stats).toEqual(summarizeVad([{ energies: quietPcm, regions: result.turns, mode: "quiet" }]));
  expect(result.stats).toMatchObject({ vad_mode: "quiet", dropped_above_noise_pct: 0 });
  expect(summarizeVad([{ energies: quietPcm, regions: original, mode: "primary" }]).dropped_above_noise_pct).toBeGreaterThan(0);
});

test("quiet diarized coverage includes #99's fallback union below the quiet threshold", () => {
  const e = new Float64Array(1_200).fill(-53);
  e.fill(-56, 100, 200); e.fill(-49, 400, 600); e.fill(-31, 800, 820);
  const result = detectDiarizedSpeech([{ startMs: 40_000, endMs: 41_000, speaker: 2 }], e);
  expect(result.stats.vad_mode).toBe("quiet");
  expect(result.turns[0]!.startMs).toBe(0);
  expect(result.turns.at(-1)!.endMs).toBe(120_000);
  expect(sentMs(result.turns)).toBe(120_000);
  disjointAndCapped(result.turns);
});

test("50 ms leading/trailing slivers and a short between-speaker gap are absorbed without overlap", () => {
  const original = [{ startMs: 1_000, endMs: 2_000, speaker: 7 }, { startMs: 2_100, endMs: 3_000, speaker: 3 }];
  const added = [{ startMs: 950, endMs: 1_050 }, { startMs: 1_950, endMs: 2_150 }, { startMs: 2_950, endMs: 3_050 }];
  const result = unionQuietTurns(original, added, new Float64Array(40).fill(-58));
  expect(result).toEqual([{ startMs: 950, endMs: 2_100, speaker: 7 }, { startMs: 2_100, endMs: 3_050, speaker: 3 }]);
  includes(result, original); includes(result, added); disjointAndCapped(result);
});

test("the union preserves uncovered gaps and ignores artificial VAD request cuts for attribution", () => {
  const e = new Float64Array(50).fill(-58);
  const original = [{ startMs: 0, endMs: 1_000, speaker: 7 }, { startMs: 1_200, endMs: 2_000, speaker: 3 }];
  expect(unionQuietTurns(original, [{ startMs: 1_000, endMs: 1_050 }], e)).toEqual([
    { startMs: 0, endMs: 1_050, speaker: 7 }, { startMs: 1_200, endMs: 2_000, speaker: 3 },
  ]);
  const one = [{ startMs: 0, endMs: 1_000, speaker: 7 }];
  const whole = unionQuietTurns(one, [{ startMs: 1_000, endMs: 2_500 }], e);
  expect(whole).toEqual([{ startMs: 0, endMs: 1_000, speaker: 7 }, { startMs: 1_000, endMs: 2_500, speaker: UNKNOWN_SPEAKER }]);
  expect(unionQuietTurns(one, [{ startMs: 1_000, endMs: 1_300 }, { startMs: 1_300, endMs: 2_500 }], e)).toEqual(whole);
});

test("extending a capped turn by 50 ms keeps every sample without a tiny new request", () => {
  const result = unionQuietTurns([{ startMs: 0, endMs: 30_000, speaker: 3 }], [{ startMs: 29_950, endMs: 30_050 }], new Float64Array(301).fill(-58));
  expect(sentMs(result)).toBe(30_050);
  expect(result).toEqual([{ startMs: 0, endMs: 29_650, speaker: 3 }, { startMs: 29_650, endMs: 30_050, speaker: 3 }]);
  disjointAndCapped(result);
});

test("long recovered coverage is capped and preserves known speaker boundaries", () => {
  const original = [{ startMs: 31_000, endMs: 35_000, speaker: 4 }], added = [{ startMs: 5_000, endMs: 75_000 }];
  const result = unionQuietTurns(original, added, new Float64Array(800).fill(-58));
  expect(sentMs(result)).toBe(70_000);
  expect(result.find((r) => r.speaker === 4)).toEqual(original[0]);
  includes(result, added); disjointAndCapped(result);
});

test("at the 32-speaker limit, nearest-turn attribution adds no invalid 33rd public speaker", () => {
  const original = Array.from({ length: 32 }, (_, speaker) => ({ startMs: speaker * 2_000, endMs: speaker * 2_000 + 1_000, speaker }));
  const result = unionQuietTurns(original, [{ startMs: 0, endMs: 64_000 }], new Float64Array(640).fill(-58));
  expect(new Set(result.map((r) => r.speaker)).size).toBe(32);
  expect(result.some((r) => r.speaker === UNKNOWN_SPEAKER)).toBe(false);
  expect(result.slice(0, 2)).toEqual([{ startMs: 0, endMs: 1_500, speaker: 0 }, { startMs: 1_500, endMs: 3_500, speaker: 1 }]);
  expect(sentMs(result)).toBe(64_000);
  for (const r of original) expect(result.find((x) => x.startMs <= r.startMs && x.endMs >= r.endMs)?.speaker).toBe(r.speaker);
  includes(result, original); disjointAndCapped(result);
});

test("an empty diarizer result still sends gated quiet speech with one unknown speaker", () => {
  const result = detectDiarizedSpeech([], quietPcm);
  expect(result.turns.map(({ speaker, ...r }) => r)).toEqual(detectSpeech(quietPcm).regions);
  expect(result.turns.every((r) => r.speaker === UNKNOWN_SPEAKER)).toBe(true);
  expect(result.stats).toMatchObject({ vad_mode: "quiet", dropped_above_noise_pct: 0 });
});

test("at the speaker cap, partial midpoint gaps never create tiny distant-speaker requests", () => {
  const original = Array.from({ length: 32 }, (_, speaker) => ({ startMs: speaker * 4_000 + 1_000, endMs: speaker * 4_000 + 2_000, speaker }));
  const energies = new Float64Array(1_300).fill(-58);
  // The midpoint is 3.5 s. Recovered coverage barely crosses it from either touching side.
  for (const tail of [50, 100, 200, 350]) {
    for (const [region, index, expected] of [
      [{ startMs: 2_000, endMs: 3_500 + tail }, 0, { startMs: 1_000, endMs: 3_500 + tail, speaker: 0 }],
      [{ startMs: 3_500 - tail, endMs: 5_000 }, 1, { startMs: 3_500 - tail, endMs: 6_000, speaker: 1 }],
    ] as const) {
      const result = unionQuietTurns(original, [region], energies);
      expect(result.length).toBe(original.length);
      expect(result[index]).toEqual(expected);
      expect(result.every((r) => r.endMs - r.startMs >= 400)).toBe(true);
      includes(result, original); includes(result, [region]); disjointAndCapped(result);
    }
  }
  // A complete 600 ms gap has two short midpoint pieces: absorb it whole into the earlier touching turn.
  const close = original.map((r, i) => i === 1 ? { ...r, startMs: 2_600 } : r);
  const joined = unionQuietTurns(close, [{ startMs: 2_000, endMs: 2_600 }], energies);
  expect(joined[0]).toEqual({ startMs: 1_000, endMs: 2_600, speaker: 0 });
  expect(joined[1]).toEqual(close[1]);
});

test("ordinary fully covered speaker turns keep their intervals and attribution", () => {
  const energies = new Float64Array(400).fill(-25);
  const segments = [{ startMs: 0, endMs: 20_000, speaker: 7 }, { startMs: 20_000, endMs: 40_000, speaker: 3 }];
  const original = speakerTurns(segments, energies), result = detectDiarizedSpeech(segments, energies);
  expect(result.turns).toEqual(original);
  expect(result).toMatchObject({ covered: true, fallback: false, droppedFrames: 0, stats: { vad_mode: "primary" } });
});

test("the final union, not VAD alone, decides fail-closed coverage", () => {
  const energies = new Float64Array(200).fill(-120);
  energies.fill(-25, 0, 20);
  for (let f = 40; f < 200; f += 20) energies.fill(-25, f, f + 2);
  const vad = { ...VAD, padMs: 0 };
  expect(detectSpeech(energies, vad).covered).toBe(false);
  const missed = detectDiarizedSpeech([{ startMs: 0, endMs: 2_000, speaker: 7 }], energies, vad);
  expect(missed).toMatchObject({ covered: false, fallback: true, stats: { vad_mode: "fallback" } });
  const retained = detectDiarizedSpeech([{ startMs: 0, endMs: 20_000, speaker: 7 }], energies, vad);
  expect(retained).toMatchObject({ covered: true, fallback: true, droppedFrames: 0 });
  expect(sentMs(retained.turns)).toBe(20_000);
});

test("primary detection repairs above-floor holes in otherwise ordinary diarized audio", () => {
  const energies = new Float64Array(400).fill(-25);
  const segments = [{ startMs: 10_000, endMs: 14_000, speaker: 7 }];
  expect(detectSpeech(energies).fallback).toBe(false);
  const result = detectDiarizedSpeech(segments, energies);
  expect(result).toMatchObject({ covered: true, fallback: false, droppedFrames: 0, stats: { vad_mode: "primary" } });
  includes(result.turns, speakerTurns(segments, energies));
  expect(sentMs(result.turns)).toBe(40_000);
  disjointAndCapped(result.turns);
});

test("long quiet coverage remains complete across request cuts without relabelling known speakers", () => {
  const energies = new Float64Array(7_200).fill(-53);
  energies.fill(-49, 1_000, 2_000); energies.fill(-31, 1_500, 1_520);
  const segments = [{ startMs: 120_000, endMs: 150_000, speaker: 7 }, { startMs: 500_000, endMs: 515_000, speaker: 3 }];
  const result = detectDiarizedSpeech(segments, energies);
  expect(result.stats).toMatchObject({ vad_mode: "quiet", dropped_above_noise_pct: 0 });
  expect(sentMs(result.turns)).toBe(720_000);
  includes(result.turns, speakerTurns(segments, energies));
  disjointAndCapped(result.turns);
  for (const speaker of [7, 3]) {
    expect(sentMs(result.turns.filter((r) => r.speaker === speaker))).toBe(sentMs(speakerTurns(segments, energies).filter((r) => r.speaker === speaker)));
  }
});

