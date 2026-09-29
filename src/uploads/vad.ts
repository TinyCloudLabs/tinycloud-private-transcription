import { PCM_BYTES_PER_SECOND } from "./audio.ts";

/**
 * Energy VAD over a 16 kHz s16le PCM file, streamed in slices (never the whole file in memory):
 * 100 ms frames; voiced when RMS >= max(-50 dBFS, p10 + 12 dB); gaps <= 1.0 s merged; regions padded
 * ±0.25 s; regions < 0.4 s dropped; regions > 30 s split at the quietest frame in their last 10 s.
 */
export const VAD = { frameMs: 100, floorDbfs: -50, aboveP10Db: 12, mergeGapMs: 1_000, padMs: 250, minMs: 400, maxMs: 30_000, splitSearchMs: 10_000 };

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

export function regionsFromEnergies(energies: Float64Array): Region[] {
  if (energies.length === 0) return [];
  const sorted = Float64Array.from(energies).sort();
  const p10 = sorted[Math.floor(0.1 * (sorted.length - 1))]!;
  const threshold = Math.max(VAD.floorDbfs, p10 + VAD.aboveP10Db);
  const totalMs = energies.length * VAD.frameMs;

  const raw: Region[] = [];
  let start = -1;
  for (let i = 0; i <= energies.length; i++) {
    const voiced = i < energies.length && energies[i]! >= threshold;
    if (voiced && start < 0) start = i;
    if (!voiced && start >= 0) {
      raw.push({ startMs: start * VAD.frameMs, endMs: i * VAD.frameMs });
      start = -1;
    }
  }
  const merged: Region[] = [];
  for (const region of raw) {
    const last = merged.at(-1);
    if (last && region.startMs - last.endMs <= VAD.mergeGapMs) last.endMs = region.endMs;
    else merged.push({ ...region });
  }
  const padded = merged
    .map((r) => ({ startMs: Math.max(0, r.startMs - VAD.padMs), endMs: Math.min(totalMs, r.endMs + VAD.padMs) }))
    .filter((r) => r.endMs - r.startMs >= VAD.minMs);
  // Padding can make neighbours overlap; coalesce so no audio is sent twice.
  const coalesced: Region[] = [];
  for (const region of padded) {
    const last = coalesced.at(-1);
    if (last && region.startMs <= last.endMs) last.endMs = Math.max(last.endMs, region.endMs);
    else coalesced.push({ ...region });
  }
  const out: Region[] = [];
  for (const region of coalesced) {
    let from = region.startMs;
    while (region.endMs - from > VAD.maxMs) {
      const searchFrom = Math.floor((from + VAD.maxMs - VAD.splitSearchMs) / VAD.frameMs);
      const searchTo = Math.floor((from + VAD.maxMs) / VAD.frameMs);
      let best = searchTo - 1;
      for (let f = searchFrom; f < searchTo; f++) if (energies[f]! <= energies[best]!) best = f;
      const cut = best * VAD.frameMs + VAD.frameMs / 2;
      out.push({ startMs: from, endMs: cut });
      from = cut;
    }
    out.push({ startMs: from, endMs: region.endMs });
  }
  return out;
}

export async function detectRegions(path: string): Promise<Region[]> {
  return regionsFromEnergies(await frameEnergies(path));
}
