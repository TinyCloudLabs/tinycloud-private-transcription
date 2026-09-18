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
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  write(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); write(8, "WAVE");
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, dataBytes, true);
  new Int16Array(buffer, 44).set(samples);
  return new Uint8Array(buffer);
}
