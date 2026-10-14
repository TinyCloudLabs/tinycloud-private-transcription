import { PCM_BYTES_PER_SECOND } from "./audio.ts";

/**
 * Energy VAD over a 16 kHz s16le PCM file, streamed in slices (never the whole file in memory):
 * 100 ms frames; voiced when RMS >= max(-50 dBFS, min(-40 dBFS, p10 + 12 dB)); gaps <= 1.0 s merged; regions padded
 * ±0.25 s; regions < 0.4 s dropped; regions > 30 s split at the quietest frame in their last 10 s.
 *
 * The relative term finds speech over a quiet room, but it must never climb above a level ordinary speech reaches:
 * continuous narration over a steady noise floor (no true pauses) has its 10th percentile inside the speech, and an
 * uncapped p10 + 12 dB kept only the loudest syllables (~29% of the audio, TC-1045). With the cap, a recording
 * whose background is louder than -40 dBFS is sent whole: no speech is lost, at the cost of sending the background.
 */
export const VAD = {
  frameMs: 100, floorDbfs: -50, fallbackDbfs: -57, aboveP10Db: 12, capDbfs: -40, mergeGapMs: 1_000, padMs: 250, minMs: 400, maxMs: 30_000, splitSearchMs: 10_000,
  /** Coverage guard: at most this share of the non-silent audio (frames ≥ floorDbfs) may go unsent before the VAD falls back. */
  maxDroppedAboveFloor: 0.1,
};

export type VadParams = typeof VAD;

const FRAME_BYTES = (PCM_BYTES_PER_SECOND * VAD.frameMs) / 1000;
const SLICE_FRAMES = 600; // 60 s per read

export async function frameEnergies(path: string): Promise<Float64Array> {
  const file = Bun.file(path);
  const total = Math.floor(file.size / FRAME_BYTES);
  const out = new Float64Array(total);
  for (let first = 0; first < total; first += SLICE_FRAMES) {
    const count = Math.min(SLICE_FRAMES, total - first);
    const buffer = await file.slice(first * FRAME_BYTES, (first + count) * FRAME_BYTES).arrayBuffer();
    const samples = new Int16Array(buffer);
    const perFrame = FRAME_BYTES / 2;
    for (let f = 0; f < count; f++) {
      let sum = 0;
      for (let i = f * perFrame; i < (f + 1) * perFrame; i++) sum += (samples[i]! / 32768) ** 2;
      const rms = Math.sqrt(sum / perFrame);
      out[first + f] = rms === 0 ? -120 : Math.max(-120, 20 * Math.log10(rms));
    }
  }
  return out;
}

export interface Region {
  startMs: number;
  endMs: number;
}

/** The voicing threshold: max(floor, min(cap, p10 + 12 dB)). */
export function vadThreshold(energies: Float64Array, vad: VadParams = VAD): number {
  if (energies.length === 0) return vad.floorDbfs;
  const sorted = Float64Array.from(energies).sort();
  const p10 = sorted[Math.floor(0.1 * (sorted.length - 1))]!;
  return Math.max(vad.floorDbfs, Math.min(vad.capDbfs, p10 + vad.aboveP10Db));
}

export function regionsFromEnergies(energies: Float64Array, threshold = vadThreshold(energies), vad: VadParams = VAD): Region[] {
  if (energies.length === 0) return [];
  const totalMs = energies.length * vad.frameMs;

  const raw: Region[] = [];
  let start = -1;
  for (let i = 0; i <= energies.length; i++) {
    const voiced = i < energies.length && energies[i]! >= threshold;
    if (voiced && start < 0) start = i;
    if (!voiced && start >= 0) {
      raw.push({ startMs: start * vad.frameMs, endMs: i * vad.frameMs });
      start = -1;
    }
  }
  const merged: Region[] = [];
  for (const region of raw) {
    const last = merged.at(-1);
    if (last && region.startMs - last.endMs <= vad.mergeGapMs) last.endMs = region.endMs;
    else merged.push({ ...region });
  }
  const padded = merged
    .map((r) => ({ startMs: Math.max(0, r.startMs - vad.padMs), endMs: Math.min(totalMs, r.endMs + vad.padMs) }))
    .filter((r) => r.endMs - r.startMs >= vad.minMs);
  // Padding can make neighbours overlap; coalesce so no audio is sent twice.
  const coalesced: Region[] = [];
  for (const region of padded) {
    const last = coalesced.at(-1);
    if (last && region.startMs <= last.endMs) last.endMs = Math.max(last.endMs, region.endMs);
    else coalesced.push({ ...region });
  }
  return coalesced.flatMap((region) => splitLong(region, energies, vad));
}

/** Cuts a region longer than VAD.maxMs at the quietest frame in the last VAD.splitSearchMs of every VAD.maxMs window. */
export function splitLong(region: Region, energies: Float64Array, vad: VadParams = VAD): Region[] {
  const out: Region[] = [];
  let from = region.startMs;
  while (region.endMs - from > vad.maxMs) {
    const searchFrom = Math.floor((from + vad.maxMs - vad.splitSearchMs) / vad.frameMs);
    const searchTo = Math.floor((from + vad.maxMs) / vad.frameMs);
    let best = searchTo - 1;
    for (let f = searchFrom; f < searchTo; f++) if (energies[f]! <= energies[best]!) best = f;
    const cut = best * vad.frameMs + vad.frameMs / 2;
    out.push({ startMs: from, endMs: cut });
    from = cut;
  }
  out.push({ startMs: from, endMs: region.endMs });
  return out;
}

/** Frames at or above the absolute floor: audio that is not silence. */
export function aboveFloorFrames(energies: Float64Array, vad: VadParams = VAD): number {
  let count = 0;
  for (const energy of energies) if (energy >= vad.floorDbfs) count++;
  return count;
}

/**
 * Frames at or above the absolute floor whose centre lies in no region (regions sorted, non-overlapping): audio that
 * is not silence, yet would not be sent.
 */
export function droppedAboveFloorFrames(energies: Float64Array, regions: readonly Region[], vad: VadParams = VAD): number {
  let dropped = 0, r = 0;
  for (let f = 0; f < energies.length; f++) {
    const centre = f * vad.frameMs + vad.frameMs / 2;
    while (r < regions.length && regions[r]!.endMs <= centre) r++;
    const inside = r < regions.length && regions[r]!.startMs <= centre;
    if (!inside && energies[f]! >= vad.floorDbfs) dropped++;
  }
  return dropped;
}

export interface Detection {
  regions: Region[];
  /** Frames above the floor that the returned regions leave unsent. */
  droppedFrames: number;
  /** Frames above the floor: the guard's denominator. */
  aboveFloorFrames: number;
  /** The relative threshold left too much audio above the floor unsent, so the regions use fallbackDbfs. */
  fallback: boolean;
  /** Share of the audio above the floor that the relative threshold would have left unsent (what tripped the fallback). */
  primaryDroppedShare: number;
  /** false: even the floor-only regions leave more than the bound unsent. The job must fail, never complete. */
  covered: boolean;
}

/**
 * VAD regions with a fail-closed coverage guard. If the relative threshold leaves more than `maxDroppedAboveFloor` of
 * the non-silent audio (frames at or above the floor) unsent, the regions are recomputed with `fallbackDbfs` as the threshold:
 * every stretch of non-silent audio, still merged, padded and cut at 30 s. A pause in a quiet room is below the floor and
 * never counts. The bound is never below one minimum region (`minMs`): the VAD never sends a stretch shorter than that
 * on its own, so a sub-second recording or a lone click at either end is the VAD's resolution, not lost speech.
 */
export function detectSpeech(energies: Float64Array, vad: VadParams = VAD): Detection {
  const aboveFloor = aboveFloorFrames(energies, vad);
  const bound = Math.max(vad.maxDroppedAboveFloor * aboveFloor, vad.minMs / vad.frameMs);
  const primary = regionsFromEnergies(energies, vadThreshold(energies, vad), vad);
  const primaryDropped = droppedAboveFloorFrames(energies, primary, vad);
  const primaryDroppedShare = aboveFloor === 0 ? 0 : primaryDropped / aboveFloor;
  if (primaryDropped <= bound) {
    return { regions: primary, droppedFrames: primaryDropped, aboveFloorFrames: aboveFloor, fallback: false, primaryDroppedShare, covered: true };
  }
  const regions = regionsFromEnergies(energies, vad.fallbackDbfs, vad);
  const droppedFrames = droppedAboveFloorFrames(energies, regions, vad);
  return { regions, droppedFrames, aboveFloorFrames: aboveFloor, fallback: true, primaryDroppedShare, covered: droppedFrames <= bound };
}
