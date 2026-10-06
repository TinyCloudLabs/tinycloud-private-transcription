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

/** Runs ffmpeg to stdout with a hard wall-clock bound; the process is killed past it. */
function spawnFfmpeg(args: string[], ffmpegPath: string | undefined, timeoutMs: number) {
  const proc = Bun.spawn([ffmpegPath ?? "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const finished = async () => {
    const [error, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    if (code !== 0) throw new Error(`ffmpeg failed (exit ${code}): ${error.trim().slice(0, 300)}`);
  };
  return { proc, finished };
}

const LEVEL_RATE = 8_000, LEVEL_FRAME = 800, LEVEL_FLOOR_DB = -120;
/**
 * 100 ms RMS levels (dB) of a recording file (TC-758). The audio is streamed through ffmpeg at
 * 8 kHz and folded into frame levels as it arrives, so memory is O(frames), not O(samples):
 * a whole meeting is never held decoded.
 */
export async function recordingLevels(path: string, opts: { ffmpegPath?: string; timeoutMs?: number } = {}): Promise<{ levels: Float64Array; durationSec: number }> {
  const { proc, finished } = spawnFfmpeg(["-i", path, "-vn", "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(LEVEL_RATE), "pipe:1"], opts.ffmpegPath, opts.timeoutMs ?? 300_000);
  const levels: number[] = [];
  let sum = 0, count = 0, samples = 0, carry = -1;
  const take = (sample: number) => {
    const value = sample / 32768; sum += value * value; count++; samples++;
    if (count === LEVEL_FRAME) { levels.push(sum > 0 ? Math.max(LEVEL_FLOOR_DB, 10 * Math.log10(sum / count)) : LEVEL_FLOOR_DB); sum = 0; count = 0; }
  };
  for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
    let i = 0;
    if (carry >= 0 && chunk.length) { take(((carry | (chunk[0]! << 8)) << 16) >> 16); carry = -1; i = 1; }
    for (; i + 1 < chunk.length; i += 2) take(((chunk[i]! | (chunk[i + 1]! << 8)) << 16) >> 16);
    if (i < chunk.length) carry = chunk[i]!;
  }
  await finished();
  return { levels: Float64Array.from(levels), durationSec: samples / LEVEL_RATE };
}

/** Decodes only [fromSec, toSec) of a recording file to 16 kHz mono PCM (input seeking). */
export async function decodeCut(path: string, fromSec: number, toSec: number, opts: { ffmpegPath?: string; timeoutMs?: number } = {}): Promise<Pcm16> {
  const { proc, finished } = spawnFfmpeg(["-ss", fromSec.toFixed(3), "-t", Math.max(0, toSec - fromSec).toFixed(3), "-i", path, "-vn", "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(PCM_RATE), "pipe:1"],
    opts.ffmpegPath, opts.timeoutMs ?? 60_000);
  const [out] = await Promise.all([new Response(proc.stdout).arrayBuffer(), finished()]);
  const samples = new Int16Array(out.slice(0, out.byteLength - (out.byteLength % 2)));
  return { samples, sampleRate: PCM_RATE, durationSec: samples.length / PCM_RATE };
}
