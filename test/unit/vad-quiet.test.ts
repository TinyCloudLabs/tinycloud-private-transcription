import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSpeech, frameEnergies, regionsFromEnergies, summarizeVad, VAD, type Detection, type Region } from "../../src/uploads/vad.ts";
import { baselineDetection, pcmFromLevels, quietSpeechLevels, sentFrames } from "../support/vad-fixtures.ts";

let dir: string;
let next = 0;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "ptx-vad-quiet-")); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
async function energiesOf(levels: Float64Array) {
  const path = join(dir, `${next++}.pcm`);
  await Bun.write(path, pcmFromLevels(levels));
  return frameEnergies(path);
}
const legacy = ({ stats, ...rest }: Detection) => rest;
function contains(regions: Region[], original: Region[]) {
  for (const r of original) {
    let end = r.startMs;
    for (const next of regions) if (next.startMs <= end && next.endMs > end) end = next.endMs;
    expect(end).toBeGreaterThanOrEqual(r.endMs);
  }
}

test("quiet speech and its -6/-10 dB PCM variants are fully covered, with the exact report constants", async () => {
  expect(VAD.quiet).toEqual({ enabled: true, medianBelowDbfs: -50, p99BelowDbfs: -30, peakAboveP10Db: 21, minPeakMs: 1_000, aboveP10Db: 3, minDbfs: -65, padMs: 500 });
  for (const gain of [0, -6, -10]) {
    const energies = await energiesOf(quietSpeechLevels(gain));
    const detection = detectSpeech(energies);
    expect(detection).toMatchObject({ fallback: false, covered: true, droppedFrames: 0, stats: { vad_mode: "quiet", speech_peak_s: 1, dropped_above_noise_pct: 0 } });
    expect(detection.stats.median_dbfs).toBeLessThan(-50);
    expect(detection.stats.p99_dbfs).toBeLessThan(-30);
    const sent = sentFrames(energies, detection.regions);
    for (const [from, to] of [[100, 200], [400, 500]]) expect(sent.slice(from, to).every(Boolean)).toBe(true);
    expect(detection.regions).toEqual([{ startMs: 9_500, endMs: 20_500 }, { startMs: 39_500, endMs: 50_500 }]);
    contains(detection.regions, baselineDetection(energies, -57).regions);
    expect(sentFrames(energies, baselineDetection(energies, -57).regions).slice(100, 200).every(Boolean)).toBe(false);
  }
});

test("steady and fluctuating room tone at -55/-60 never passes the speech-presence gate", async () => {
  for (const floor of [-55, -60]) for (const fluctuating of [false, true]) {
    const levels = Float64Array.from({ length: 1_000 }, (_, f) => floor + (fluctuating ? 4 * Math.sin(f * 0.11) : 0));
    const energies = await energiesOf(levels);
    const detection = detectSpeech(energies);
    expect(detection.stats.vad_mode).not.toBe("quiet");
    expect(detection.stats.speech_peak_s).toBe(0);
    expect(JSON.stringify(legacy(detection))).toBe(JSON.stringify(baselineDetection(energies, -57)));
  }
});

test("loud speech over fluctuating tone takes the byte-identical non-quiet path", async () => {
  const levels = Float64Array.from({ length: 1_000 }, (_, f) => -60 + 4 * Math.sin(f * 0.11));
  levels.fill(-23, 400, 500);
  const energies = await energiesOf(levels);
  const detection = detectSpeech(energies);
  expect(detection.stats.median_dbfs).toBeLessThan(-50);
  expect(detection.stats.speech_peak_s).toBeGreaterThanOrEqual(1);
  expect(detection.stats.p99_dbfs).toBeGreaterThanOrEqual(-30);
  expect(detection.stats.vad_mode).toBe("primary");
  expect(JSON.stringify(legacy(detection))).toBe(JSON.stringify(baselineDetection(energies, -57)));
});

test("gate boundaries: median and p99 are strict; exactly 1 s at p10+21 is sufficient", () => {
  const atBoundary = (noise: number, peak: number, count: number) => {
    const e = new Float64Array(1_000).fill(noise);
    e.fill(peak, 400, 400 + count);
    return detectSpeech(e);
  };
  expect(atBoundary(-50, -29, 10).stats.vad_mode).not.toBe("quiet");
  expect(atBoundary(-60, -30, 20).stats.vad_mode).not.toBe("quiet");
  expect(atBoundary(-62, -41, 9).stats).toMatchObject({ speech_peak_s: 0.9, vad_mode: "primary" });
  expect(atBoundary(-62, -41.01, 10).stats).toMatchObject({ speech_peak_s: 0, vad_mode: "primary" });
  expect(atBoundary(-62, -41, 10).stats).toMatchObject({ speech_peak_s: 1, vad_mode: "quiet" });
});

test("quiet mode retains fallback audio below its own threshold, coalescing and splitting the union without gaps", () => {
  const e = new Float64Array(1_200).fill(-53);
  e.fill(-56, 100, 200); // fallback sends this; quiet threshold is clamped at -50 and would omit it
  e.fill(-49, 400, 600); // below the primary threshold, trips fallback
  e.fill(-31, 800, 820); // >21 dB above p10, but still below -30
  const before = baselineDetection(e, -57);
  expect(before.fallback).toBe(true);
  const quietOnly = regionsFromEnergies(e, -50, { ...VAD, padMs: 500 });
  expect(sentFrames(e, quietOnly).slice(100, 200).some(Boolean)).toBe(false);
  const detection = detectSpeech(e);
  expect(detection.stats.vad_mode).toBe("quiet");
  contains(detection.regions, before.regions);
  expect(detection.regions[0]!.startMs).toBe(0);
  expect(detection.regions.at(-1)!.endMs).toBe(120_000);
  for (let i = 0; i < detection.regions.length; i++) {
    const r = detection.regions[i]!;
    expect(r.endMs - r.startMs).toBeLessThanOrEqual(30_000);
    if (i > 0) expect(r.startMs).toBe(detection.regions[i - 1]!.endMs);
  }
});

test("every non-quiet case is byte-identical to PR 1; the rollback flag restores PR 1 even for quiet inputs", () => {
  const cases = [new Float64Array(), new Float64Array(1).fill(-20), new Float64Array(600).fill(-120),
    new Float64Array(600).fill(-60), new Float64Array(600).fill(-34), new Float64Array(600).fill(-46),
    Float64Array.from({ length: 1_000 }, (_, f) => f % 100 < 80 ? -25 : -120)];
  for (const e of cases) {
    const detection = detectSpeech(e);
    expect(detection.stats.vad_mode).not.toBe("quiet");
    expect(JSON.stringify(legacy(detection))).toBe(JSON.stringify(baselineDetection(e, -57)));
  }
  const e = quietSpeechLevels();
  const detection = detectSpeech(e, { ...VAD, quiet: { ...VAD.quiet, enabled: false } });
  expect(JSON.stringify(legacy(detection))).toBe(JSON.stringify(baselineDetection(e, -57)));
  expect(detection.stats.vad_mode).toBe("primary");
});

test("stats are exact floor-index percentiles and frame-weighted loss above max(-65, p10+6)", () => {
  const e = quietSpeechLevels();
  expect(detectSpeech(e).stats).toEqual({ vad_mode: "quiet", noise_floor_dbfs: -58, median_dbfs: -58, p99_dbfs: -52, speech_peak_s: 1, dropped_above_noise_pct: 0 });
  expect(detectSpeech(e, { ...VAD, quiet: { ...VAD.quiet, enabled: false } }).stats.dropped_above_noise_pct).toBeCloseTo(90.9, 1);
  expect(detectSpeech(new Float64Array()).stats).toEqual({ vad_mode: "primary", noise_floor_dbfs: -120, median_dbfs: -120, p99_dbfs: -120, speech_peak_s: 0, dropped_above_noise_pct: 0 });
  const low = new Float64Array(100).fill(-80); low.fill(-64, 20, 40);
  expect(summarizeVad([{ energies: low, regions: [], mode: "primary" }]).dropped_above_noise_pct).toBe(100);
  expect(summarizeVad([{ energies: low, regions: [{ startMs: 2_000, endMs: 3_000 }], mode: "primary" }]).dropped_above_noise_pct).toBe(50);
});

test("channel diagnostics pool actual frames and coverage, with quiet/fallback/primary mode precedence", () => {
  const quiet = quietSpeechLevels(), normal = new Float64Array(1_000).fill(-25);
  const q = detectSpeech(quiet), n = detectSpeech(normal);
  const summary = summarizeVad([{ energies: quiet, regions: q.regions, mode: "quiet" }, { energies: normal, regions: n.regions, mode: "primary" }]);
  expect(summary).toEqual({ vad_mode: "quiet", noise_floor_dbfs: -58, median_dbfs: -36, p99_dbfs: -25, speech_peak_s: 101, dropped_above_noise_pct: 0 });
  expect(summarizeVad([{ energies: normal, regions: n.regions, mode: "primary" }, { energies: normal, regions: n.regions, mode: "fallback" }]).vad_mode).toBe("fallback");
});
