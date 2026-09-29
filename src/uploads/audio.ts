import { open } from "node:fs/promises";
import { CONTENT_TYPES, type UploadContentType } from "./config.ts";

export const PCM_RATE = 16_000;
/** Bytes per second of 16 kHz mono s16le. */
export const PCM_BYTES_PER_SECOND = PCM_RATE * 2;

export interface ProbeResult {
  durationSeconds: number;
  channels: number;
}

export type ProbeFailure = "invalid_audio" | "recording_too_long" | "unsupported_recording";

const FORMAT_FOR: Record<UploadContentType, RegExp> = {
  "audio/mpeg": /(^|,)mp3(,|$)/,
  "audio/wav": /(^|,)wav(,|$)/,
  "audio/ogg": /(^|,)ogg(,|$)/,
};

/** Reads container facts with ffprobe. Never reads or logs content. */
export async function probeAudio(
  path: string,
  contentType: UploadContentType,
  limits: { maxDurationSeconds: number; maxChannels: number },
  ffprobePath = "ffprobe",
): Promise<{ ok: true; probe: ProbeResult } | { ok: false; code: ProbeFailure; message: string }> {
  if (!(CONTENT_TYPES as readonly string[]).includes(contentType)) return { ok: false, code: "invalid_audio", message: "Unsupported content type" };
  const proc = Bun.spawn(
    [ffprobePath, "-v", "error", "-show_entries", "stream=codec_type,channels:format=duration,format_name", "-of", "json", path],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return { ok: false, code: "invalid_audio", message: "The recording could not be read as audio" };
  let parsed: { streams?: { codec_type?: string; channels?: number }[]; format?: { duration?: string; format_name?: string } };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, code: "invalid_audio", message: "The recording could not be read as audio" };
  }
  const audio = (parsed.streams ?? []).filter((stream) => stream.codec_type === "audio");
  const format = parsed.format?.format_name ?? "";
  const duration = Number(parsed.format?.duration);
  if (audio.length !== 1 || !FORMAT_FOR[contentType].test(format) || !Number.isFinite(duration) || duration <= 0) {
    return { ok: false, code: "invalid_audio", message: "The recording is not a single-stream audio file of the declared type" };
  }
  const channels = audio[0]!.channels ?? 0;
  if (!Number.isSafeInteger(channels) || channels < 1 || channels > limits.maxChannels) {
    return { ok: false, code: "unsupported_recording", message: `Recordings must have 1 to ${limits.maxChannels} channels` };
  }
  if (duration > limits.maxDurationSeconds) {
    return { ok: false, code: "recording_too_long", message: `Recordings longer than ${limits.maxDurationSeconds} seconds are not accepted` };
  }
  return { ok: true, probe: { durationSeconds: Math.round(duration * 1000) / 1000, channels } };
}

/**
 * Decodes one channel (or a mono downmix when `channel` is null) to 16 kHz s16le at `tmp` on disk; the
 * caller renames it into place. The whole recording is never held in memory. `signal` kills ffmpeg when
 * the claim is lost.
 */
export async function decodeChannelToPcm(input: string, tmp: string, channel: number | null, signal: AbortSignal, ffmpegPath = "ffmpeg") {
  const filter = channel === null ? ["-ac", "1"] : ["-af", `pan=mono|c0=c${channel}`];
  const proc = Bun.spawn(
    [ffmpegPath, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input, "-vn", ...filter, "-ar", String(PCM_RATE), "-f", "s16le", "-acodec", "pcm_s16le", tmp],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  const kill = () => proc.kill();
  signal.addEventListener("abort", kill, { once: true });
  try {
    const code = await proc.exited;
    if (signal.aborted) throw new Error("decode aborted");
    if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
  } finally {
    signal.removeEventListener("abort", kill);
  }
}

/** Reads [startMs, endMs) of a 16 kHz s16le PCM file. */
export async function readPcmRange(path: string, startMs: number, endMs: number): Promise<Int16Array> {
  const from = Math.floor((startMs * PCM_RATE) / 1000) * 2;
  const to = Math.ceil((endMs * PCM_RATE) / 1000) * 2;
  const buffer = await Bun.file(path).slice(from, to).arrayBuffer();
  return new Int16Array(buffer, 0, Math.floor(buffer.byteLength / 2));
}

/** fsyncs a directory so a rename inside it is durable. */
export async function syncDir(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
