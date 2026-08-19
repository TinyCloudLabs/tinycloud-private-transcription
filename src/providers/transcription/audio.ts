/**
 * Minimal audio plumbing for the batch path: decode whatever Vexa persisted (opus/webm master, or WAV)
 * ONCE with ffmpeg into 16 kHz mono s16le PCM, then cut turns by sample offset and wrap them as WAV.
 * ffmpeg is only needed for the decode (apt/apk `ffmpeg`; see Dockerfile).
 */

export interface Pcm16 {
  samples: Int16Array;
  sampleRate: number;
  durationSec: number;
}

export const PCM_RATE = 16_000;

export async function decodeToPcm(bytes: Uint8Array, opts: { ffmpegPath?: string; sampleRate?: number } = {}): Promise<Pcm16> {
  const rate = opts.sampleRate ?? PCM_RATE;
  const proc = Bun.spawn(
    [opts.ffmpegPath ?? "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(rate), "pipe:1"],
    { stdin: bytes as unknown as Uint8Array<ArrayBuffer>, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`ffmpeg decode failed (exit ${code}): ${err.trim().slice(0, 300)}`);
  const samples = new Int16Array(out.slice(0, out.byteLength - (out.byteLength % 2)));
  return { samples, sampleRate: rate, durationSec: samples.length / rate };
}

/** RMS in dBFS over the whole buffer (-Infinity for digital silence). */
export function rmsDbfs(pcm: Pcm16): number {
  const s = pcm.samples;
  if (s.length === 0) return -Infinity;
  let acc = 0;
  for (let i = 0; i < s.length; i++) acc += (s[i]! / 32768) ** 2;
  const rms = Math.sqrt(acc / s.length);
  return rms === 0 ? -Infinity : 20 * Math.log10(rms);
}

/** Cut [startSec, endSec) and return a 16-bit mono WAV file (bytes). */
export function sliceToWav(pcm: Pcm16, startSec: number, endSec: number): Uint8Array {
  const from = Math.max(0, Math.floor(startSec * pcm.sampleRate));
  const to = Math.min(pcm.samples.length, Math.ceil(endSec * pcm.sampleRate));
  return pcmToWav(pcm.samples.subarray(from, Math.max(from, to)), pcm.sampleRate);
}

export function pcmToWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + dataBytes, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(samples);
  return new Uint8Array(buf);
}
