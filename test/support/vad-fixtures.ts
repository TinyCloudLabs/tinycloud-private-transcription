import { PCM_RATE } from "../../src/uploads/audio.ts";
import { aboveFloorFrames, droppedAboveFloorFrames, regionsFromEnergies, VAD, vadThreshold, type Region } from "../../src/uploads/vad.ts";

/** Synthetic speech envelopes and room tone: deterministic 200 Hz PCM, with the given RMS in each 100 ms frame. */
export function pcmFromLevels(levels: ArrayLike<number>): Int16Array {
  const perFrame = PCM_RATE * VAD.frameMs / 1000;
  const pcm = new Int16Array(levels.length * perFrame);
  for (let f = 0; f < levels.length; f++) {
    const amplitude = levels[f]! <= -120 ? 0 : 32768 * Math.SQRT2 * 10 ** (levels[f]! / 20);
    for (let s = 0; s < perFrame; s++) pcm[f * perFrame + s] = Math.round(amplitude * Math.sin(2 * Math.PI * 200 * s / PCM_RATE));
  }
  return pcm;
}

/** Frozen cf3cb40 detection, with a selectable fallback floor for the TC-1090 baseline. */
export function baselineDetection(energies: Float64Array, fallbackDbfs = -50) {
  const aboveFloor = aboveFloorFrames(energies);
  const bound = Math.max(VAD.maxDroppedAboveFloor * aboveFloor, VAD.minMs / VAD.frameMs);
  const primary = regionsFromEnergies(energies, vadThreshold(energies));
  const primaryDropped = droppedAboveFloorFrames(energies, primary);
  const primaryDroppedShare = aboveFloor === 0 ? 0 : primaryDropped / aboveFloor;
  const fallback = primaryDropped > bound;
  const regions = fallback ? regionsFromEnergies(energies, fallbackDbfs) : primary;
  const droppedFrames = droppedAboveFloorFrames(energies, regions);
  return { regions, droppedFrames, aboveFloorFrames: aboveFloor, fallback, primaryDroppedShare, covered: droppedFrames <= bound };
}

export function sentFrames(energies: Float64Array, regions: readonly Region[]) {
  return Array.from(energies, (_, f) => {
    const centre = (f + 0.5) * VAD.frameMs;
    return regions.some((r) => r.startMs <= centre && centre < r.endMs);
  });
}

/** Quiet far-field speech with a full second of peaks; attenuation is applied before PCM quantization. */
export function quietSpeechLevels(gainDb = 0) {
  const levels = new Float64Array(1_000).fill(-58 + gainDb);
  levels.fill(-54 + gainDb, 100, 200);
  levels.fill(-52 + gainDb, 400, 500);
  levels.fill(-36 + gainDb, 150, 160);
  return levels;
}
