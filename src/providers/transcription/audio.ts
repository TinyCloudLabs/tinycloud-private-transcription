/**
 * Minimal audio plumbing for retained-recording recovery: decode whatever Vexa persisted once with
 * ffmpeg into 16 kHz mono s16le PCM, then cut bounded windows and wrap them as WAV.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Pcm16 {
  samples: Int16Array;
  sampleRate: number;
  durationSec: number;
}

export const PCM_RATE = 16_000;

export async function decodeToPcm(bytes: Uint8Array, opts: { ffmpegPath?: string; sampleRate?: number } = {}): Promise<Pcm16> {
  const rate = opts.sampleRate ?? PCM_RATE;
  const dir = await mkdtemp(join(tmpdir(), "ptx-audio-"));
  const inPath = join(dir, "in.bin");
  const outPath = join(dir, "out.s16le");
  try {
    await Bun.write(inPath, bytes as Uint8Array<ArrayBuffer>);
    const proc = Bun.spawn(
      [opts.ffmpegPath ?? "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", inPath, "-vn", "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(rate), outPath],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    const [error, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`ffmpeg decode failed (exit ${code}): ${error.trim().slice(0, 300)}`);
    const out = await Bun.file(outPath).arrayBuffer();
    const samples = new Int16Array(out.slice(0, out.byteLength - (out.byteLength % 2)));
    return { samples, sampleRate: rate, durationSec: samples.length / rate };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** RMS in dBFS over the complete decoded recording (-Infinity for digital silence). */
export function rmsDbfs(pcm: Pcm16): number {
  if (pcm.samples.length === 0) return -Infinity;
  let sum = 0;
  for (const sample of pcm.samples) sum += (sample / 32768) ** 2;
  const rms = Math.sqrt(sum / pcm.samples.length);
  return rms === 0 ? -Infinity : 20 * Math.log10(rms);
}

/** Cut [startSec, endSec) and return a 16-bit mono WAV file. */
export function sliceToWav(pcm: Pcm16, startSec: number, endSec: number): Uint8Array {
  const from = Math.max(0, Math.floor(startSec * pcm.sampleRate));
  const to = Math.min(pcm.samples.length, Math.ceil(endSec * pcm.sampleRate));
  return pcmToWav(pcm.samples.subarray(from, Math.max(from, to)), pcm.sampleRate);
}

export function pcmToWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  out.set(wavHeader(samples.length * 2, sampleRate));
  new Int16Array(out.buffer, 44).set(samples);
  return out;
}

/** The 44-byte header of a 16-bit mono PCM WAV file whose sample data is `dataBytes` long. */
export function wavHeader(dataBytes: number, sampleRate: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(44));
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); write(8, "WAVE");
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, dataBytes, true);
  return new Uint8Array(view.buffer);
}

/**
 * One decode path for every gap-fill read of a recording (TC-758): the same ffmpeg arguments, the
 * same 16 kHz rate, and `aresample=async=1`, which fills container-timestamp gaps (concatenated
 * chunks, a recorder pause) with silence. Levels, alignment and cuts therefore share one clock —
 * decoded sample index / 16 kHz — and cuts are taken by sample offset, never by `-ss` seeking,
 * which would follow container timestamps instead.
 */
const RECORDING_ARGS = (path: string) => ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", path, "-vn", "-af", "aresample=async=1",
  "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(PCM_RATE), "pipe:1"];
const LEVEL_FRAME = PCM_RATE / 10, LEVEL_FLOOR_DB = -120;

/**
 * Streams decoded samples to `take(samples, firstIndex)` as they arrive; `take` returns false to
 * stop early. Memory is O(chunk). ffmpeg is killed past `timeoutMs` (default 5 min).
 */
async function streamRecording(path: string, take: (samples: Int16Array, firstIndex: number) => boolean | void, opts: { ffmpegPath?: string; timeoutMs?: number } = {}): Promise<number> {
  const proc = Bun.spawn([opts.ffmpegPath ?? "ffmpeg", ...RECORDING_ARGS(path)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false, stopped = false, index = 0, carry: number | null = null;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs ?? 300_000);
  const stderr = new Response(proc.stderr).text();
  try {
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      // s16le samples may straddle chunk boundaries: carry an odd trailing byte forward.
      let bytes = chunk;
      if (carry !== null) { bytes = new Uint8Array(chunk.byteLength + 1); bytes[0] = carry; bytes.set(chunk, 1); }
      const even = bytes.byteLength & ~1;
      carry = even < bytes.byteLength ? bytes[even]! : null;
      const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even));
      if (samples.length && take(samples, index) === false) { stopped = true; index += samples.length; proc.kill(); break; }
      index += samples.length;
    }
  } finally { clearTimeout(timer); }
  const [error, code] = await Promise.all([stderr, proc.exited]);
  if (timedOut) throw new Error("ffmpeg timed out");
  if (!stopped && code !== 0) throw new Error(`ffmpeg failed (exit ${code}): ${error.trim().slice(0, 300)}`);
  return index;
}

/** 100 ms RMS levels (dB) of a recording file, on the shared decode clock; memory is O(frames). */
export async function recordingLevels(path: string, opts: { ffmpegPath?: string; timeoutMs?: number } = {}): Promise<{ levels: Float64Array; durationSec: number }> {
  const levels: number[] = [];
  let sum = 0, count = 0;
  const samples = await streamRecording(path, (chunk) => {
    for (const sample of chunk) {
      const value = sample / 32768; sum += value * value;
      if (++count === LEVEL_FRAME) { levels.push(sum > 0 ? Math.max(LEVEL_FLOOR_DB, 10 * Math.log10(sum / count)) : LEVEL_FLOOR_DB); sum = 0; count = 0; }
    }
  }, opts);
  return { levels: Float64Array.from(levels), durationSec: samples / PCM_RATE };
}

/**
 * Cuts [from, to) seconds out of a recording file by decoded sample index, on the same clock as
 * `recordingLevels`. One pass, stopping after the last cut; cuts are tiny (≤ 30 s each).
 */
export async function recordingCuts(path: string, cuts: Array<{ from: number; to: number }>, opts: { ffmpegPath?: string; timeoutMs?: number } = {}): Promise<Pcm16[]> {
  const bounds = cuts.map((cut) => [Math.round(cut.from * PCM_RATE), Math.round(cut.to * PCM_RATE)] as const);
  const out = bounds.map(([a, b]) => new Int16Array(Math.max(0, b - a)));
  const filled = bounds.map(() => 0), last = Math.max(0, ...bounds.map(([, b]) => b));
  await streamRecording(path, (chunk, first) => {
    const end = first + chunk.length;
    for (const [i, [a, b]] of bounds.entries()) {
      const lo = Math.max(a, first), hi = Math.min(b, end);
      if (hi > lo) { out[i]!.set(chunk.subarray(lo - first, hi - first), lo - a); filled[i] = Math.max(filled[i]!, hi - a); }
    }
    return end < last;
  }, opts);
  // A recording shorter than planned yields a shorter cut, never invented samples.
  return out.map((samples, i) => { const kept = samples.subarray(0, filled[i]); return { samples: kept, sampleRate: PCM_RATE, durationSec: kept.length / PCM_RATE }; });
}
