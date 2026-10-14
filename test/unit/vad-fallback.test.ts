import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSpeech, frameEnergies, regionsFromEnergies, VAD } from "../../src/uploads/vad.ts";
import { baselineDetection, pcmFromLevels, sentFrames } from "../support/vad-fixtures.ts";

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "ptx-vad-fallback-")); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

test("TC-1090: fallback at -57 covers quiet speech that -50 discards, from generated PCM", async () => {
  const levels = new Float64Array(1_200).fill(-58);
  levels.fill(-54, 100, 200); // quiet words below the old fallback floor
  levels.fill(-49, 250, 350); // enough above-floor speech to trip the unchanged guard
  levels.fill(-40, 450, 470); // louder syllables kept by the primary
  const path = join(dir, "quiet-speech.pcm");
  await Bun.write(path, pcmFromLevels(levels));
  const energies = await frameEnergies(path);
  const old = baselineDetection(energies);
  const detection = detectSpeech(energies);
  expect(old.fallback).toBe(true);
  expect(detection).toMatchObject({ fallback: true, covered: true, droppedFrames: 0 });
  expect(detection.primaryDroppedShare).toBe(old.primaryDroppedShare);
  expect(sentFrames(energies, old.regions).slice(100, 200).filter(Boolean).length).toBe(0);
  expect(sentFrames(energies, detection.regions).slice(100, 200).every(Boolean)).toBe(true);
  expect(sentFrames(energies, detection.regions).slice(250, 350).every(Boolean)).toBe(true);
});

test("lower fallback regions contain every old interval, including file edges, merging and 30 s cuts", () => {
  let seed = 1090;
  for (const length of [1, 3, 4, 20, 600, 1_200, 6_300]) {
    const energies = Float64Array.from({ length }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return [-120, -65, -60, -58, -57, -54, -50, -49, -40, -20][seed % 10]!;
    });
    const old = regionsFromEnergies(energies, -50);
    const regions = regionsFromEnergies(energies, -57);
    for (const r of old) {
      let end = r.startMs;
      for (const next of regions) if (next.startMs <= end && next.endMs > end) end = next.endMs;
      expect(end).toBeGreaterThanOrEqual(r.endMs);
    }
    expect(detectSpeech(energies).droppedFrames).toBeLessThanOrEqual(baselineDetection(energies).droppedFrames);
    if (baselineDetection(energies).covered) expect(detectSpeech(energies).covered).toBe(true);
    for (const r of regions) expect(r.endMs - r.startMs).toBeLessThanOrEqual(VAD.maxMs);
  }
});

test("every non-fallback detection is byte-identical to cf3cb40", async () => {
  const paused = new Float64Array(1_000).fill(-120);
  for (let f = 0; f < paused.length; f += 100) paused.fill(-25, f, f + 80);
  const cases = [new Float64Array(), new Float64Array(1).fill(-20), new Float64Array(100).fill(-120),
    new Float64Array(600).fill(-60), new Float64Array(600).fill(-55), new Float64Array(600).fill(-34), paused];
  for (const [index, levels] of cases.entries()) {
    const path = join(dir, `normal-${index}.pcm`);
    await Bun.write(path, pcmFromLevels(levels));
    const energies = await frameEnergies(path);
    const old = baselineDetection(energies);
    expect(old.fallback).toBe(false);
    const { stats, ...legacy } = detectSpeech(energies);
    expect(JSON.stringify(legacy)).toBe(JSON.stringify(old));
  }
});
