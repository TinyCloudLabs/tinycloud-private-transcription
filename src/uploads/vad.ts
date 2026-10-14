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
  quiet: { enabled: true, medianBelowDbfs: -50, p99BelowDbfs: -30, peakAboveP10Db: 21, minPeakMs: 1_000, aboveP10Db: 3, minDbfs: -65, padMs: 500 },
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
  /** false: even the selected regions leave more than the bound unsent. The job must fail, never complete. */
  covered: boolean;
  stats: VadStats;
}

export type VadMode = "primary" | "fallback" | "quiet";

/** Additive result stats. Frame-centre coverage uses the same convention as the existing floor guard. */
export interface VadStats {
  vad_mode: VadMode;
  noise_floor_dbfs: number;
  median_dbfs: number;
  p99_dbfs: number;
  speech_peak_s: number;
  dropped_above_noise_pct: number;
}

function energyProfile(energies: Float64Array, vad: VadParams) {
  const sorted = Float64Array.from(energies).sort();
  // Floor-index percentiles match vadThreshold and REPORT.md's TS sketch. Empty PCM has the digital-silence level.
  const at = (q: number) => sorted.length === 0 ? -120 : sorted[Math.floor(q * (sorted.length - 1))]!;
  const p10 = at(0.1), median = at(0.5), p99 = at(0.99);
  let peakFrames = 0;
  for (const energy of energies) if (energy >= p10 + vad.quiet.peakAboveP10Db) peakFrames++;
  return { p10, median, p99, peakFrames };
}

function statsForRegions(energies: Float64Array, regions: readonly Region[], mode: VadMode, vad: VadParams, profile = energyProfile(energies, vad)): VadStats {
  const noiseVad = { ...vad, floorDbfs: Math.max(vad.quiet.minDbfs, profile.p10 + 6) };
  const aboveNoise = aboveFloorFrames(energies, noiseVad);
  return {
    vad_mode: mode, noise_floor_dbfs: profile.p10, median_dbfs: profile.median, p99_dbfs: profile.p99,
    speech_peak_s: profile.peakFrames * vad.frameMs / 1000,
    dropped_above_noise_pct: aboveNoise === 0 ? 0 : Math.round(droppedAboveFloorFrames(energies, regions, noiseVad) / aboveNoise * 1000) / 10,
  };
}

/** Job diagnostics over pooled channel frames; mode is quiet if any channel is quiet, then fallback, then primary. */
export function summarizeVad(channels: readonly { energies: Float64Array; regions: readonly Region[]; mode: VadMode }[], vad: VadParams = VAD): VadStats {
  const pooled = new Float64Array(channels.reduce((sum, c) => sum + c.energies.length, 0));
  const regions: Region[] = [];
  let offset = 0;
  for (const channel of channels) {
    pooled.set(channel.energies, offset);
    regions.push(...channel.regions.map((r) => ({ startMs: r.startMs + offset * vad.frameMs, endMs: r.endMs + offset * vad.frameMs })));
    offset += channel.energies.length;
  }
  const mode = channels.some((c) => c.mode === "quiet") ? "quiet" : channels.some((c) => c.mode === "fallback") ? "fallback" : "primary";
  return statsForRegions(pooled, regions, mode, vad);
}

/** Coalesce the exact union, then split without gaps or duplicate audio. Do not merge additional gaps here. */
function unionRegions(regions: readonly Region[], energies: Float64Array, vad: VadParams): Region[] {
  const sorted = [...regions].sort((a, b) => a.startMs - b.startMs);
  const union: Region[] = [];
  for (const region of sorted) {
    const last = union.at(-1);
    if (last && region.startMs <= last.endMs) last.endMs = Math.max(last.endMs, region.endMs);
    else union.push({ ...region });
  }
  return union.flatMap((region) => splitLong(region, energies, vad));
}

/**
 * VAD regions with a fail-closed coverage guard. If the relative threshold leaves more than `maxDroppedAboveFloor` of
 * the non-silent audio (frames at or above the floor) unsent, the regions are recomputed with `fallbackDbfs` as the threshold:
 * every stretch of non-silent audio, still merged, padded and cut at 30 s. A pause in a quiet room is below the floor and
 * never counts. The bound is never below one minimum region (`minMs`): the VAD never sends a stretch shorter than that
 * on its own, so a sub-second recording or a lone click at either end is the VAD's resolution, not lost speech.
 * Quiet mode uses the speech-presence gate and p10-relative threshold from TC-1093, with 500 ms padding, and retains
 * the exact union with the non-quiet path. The floor guard and primaryDroppedShare keep their original meanings.
 */
export function detectSpeech(energies: Float64Array, vad: VadParams = VAD): Detection {
  const aboveFloor = aboveFloorFrames(energies, vad);
  const bound = Math.max(vad.maxDroppedAboveFloor * aboveFloor, vad.minMs / vad.frameMs);
  const primary = regionsFromEnergies(energies, vadThreshold(energies, vad), vad);
  const primaryDropped = droppedAboveFloorFrames(energies, primary, vad);
  const primaryDroppedShare = aboveFloor === 0 ? 0 : primaryDropped / aboveFloor;
  const fallback = primaryDropped > bound;
  let regions = fallback ? regionsFromEnergies(energies, vad.fallbackDbfs, vad) : primary;
  const profile = energyProfile(energies, vad);
  const quiet = vad.quiet.enabled && profile.median < vad.quiet.medianBelowDbfs && profile.p99 < vad.quiet.p99BelowDbfs
    && profile.peakFrames * vad.frameMs >= vad.quiet.minPeakMs;
  if (quiet) {
    const threshold = Math.min(vad.floorDbfs, Math.max(vad.quiet.minDbfs, profile.p10 + vad.quiet.aboveP10Db));
    const quietRegions = regionsFromEnergies(energies, threshold, { ...vad, padMs: vad.quiet.padMs });
    // The exact quiet threshold can be higher than TC-1090's fallback (-57). Retain all previously sent audio.
    regions = unionRegions([...regions, ...quietRegions], energies, vad);
  }
  const droppedFrames = droppedAboveFloorFrames(energies, regions, vad);
  const mode = quiet ? "quiet" : fallback ? "fallback" : "primary";
  return { regions, droppedFrames, aboveFloorFrames: aboveFloor, fallback: quiet ? false : fallback, primaryDroppedShare, covered: droppedFrames <= bound,
    stats: statsForRegions(energies, regions, mode, vad, profile) };
}
